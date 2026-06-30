"""
KML sector-boundary parser for the live-replay (SWIM sector capture) feature.

Parses an FAA "AllSectors"-style KML (the ``AllSectors.kml`` shipped with the
SwimReader project) into per-sector airspace volumes that SSG can use as a
*geometric fallback* for sector membership. Track ownership
(``controllingFacility`` / ``controllingSector`` from SWIM) is the primary
membership signal; this polygon test is only consulted when ownership data is
missing or ambiguous (see the live-capture client).

KML shape notes (from AllSectors.kml):
  - Sectors live under nested ``<Folder>``s:
        CENTER_AIRSPACE / <region> / <ARTCC> / <FeatureLayer "ZTL_ULTRA_…"> / <Placemark>
    The FeatureLayer folder name (e.g. ``ZTL_ULTRA_03-07-23``) yields the
    facility (``ZTL``) and stratum (``ULTRA``).
  - Each ``<Placemark>`` has ``<name>`` = the sector number (e.g. ``2``) and a
    ``<description>`` CDATA HTML table carrying ``BASE`` / ``MAX_ALT`` (the
    altitude stratum, in feet) and a ``FolderPath`` ending in the full sector
    designator (e.g. ``…/ZTL/Ultra High (11)/00201``).
  - Geometry is usually ``<MultiGeometry><LineString><coordinates>`` with a
    *closed* ring (first vertex == last) rather than a ``<Polygon>``; we treat
    closed LineStrings and Polygon outer rings identically.
  - Coordinates are whitespace-separated ``lon,lat[,alt]`` triples.
  - A single sector may be split across multiple ``<Placemark>``s (multi-part);
    they are unioned under one :class:`SectorBoundary`.
"""
from __future__ import annotations

import logging
import re
import xml.etree.ElementTree as ET
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, List, Optional, Tuple

from utils.artcc_lookup import point_in_polygon

logger = logging.getLogger(__name__)


def _localname(tag: str) -> str:
    """Strip the ``{namespace}`` prefix ElementTree prepends to tags."""
    return tag.rsplit('}', 1)[-1] if '}' in tag else tag


def _parse_coordinates(text: str) -> List[Tuple[float, float]]:
    """Parse a KML ``<coordinates>`` blob into a list of ``(lon, lat)`` tuples.

    Altitude (the optional third component) is discarded — sector lateral
    geometry is 2-D; vertical extent is carried separately on the volume.
    """
    ring: List[Tuple[float, float]] = []
    for token in text.split():
        parts = token.split(',')
        if len(parts) < 2:
            continue
        try:
            lon = float(parts[0])
            lat = float(parts[1])
        except ValueError:
            continue
        ring.append((lon, lat))
    return ring


@dataclass
class SectorVolume:
    """One lateral polygon part of a sector, with an optional altitude band.

    ``ring`` is a closed list of ``(lon, lat)`` vertices (matching the
    convention used by :func:`utils.artcc_lookup.point_in_polygon` and
    ``CustomBoundary``).
    """
    ring: List[Tuple[float, float]]
    floor_ft: Optional[int] = None
    ceiling_ft: Optional[int] = None

    def contains(self, lat: float, lon: float, altitude_ft: Optional[float] = None) -> bool:
        if len(self.ring) < 4:
            return False
        if not point_in_polygon(lat, lon, self.ring):
            return False
        if altitude_ft is not None:
            if self.floor_ft is not None and altitude_ft < self.floor_ft:
                return False
            if self.ceiling_ft is not None and altitude_ft > self.ceiling_ft:
                return False
        return True


@dataclass
class SectorBoundary:
    """A named sector's full airspace (one or more :class:`SectorVolume` parts).

    ``key`` is the canonical ``FACILITY/SECTOR`` identifier (e.g. ``ZTL/02``).
    ``designator`` is the long form parsed from the description when available
    (e.g. ``00201``). ``stratum`` is the vertical band label (``ULTRA``,
    ``HIGH``, ``LOW``) derived from the FeatureLayer folder name.
    """
    facility: str
    sector: str
    designator: Optional[str] = None
    stratum: Optional[str] = None
    volumes: List[SectorVolume] = field(default_factory=list)

    @property
    def key(self) -> str:
        return f"{self.facility}/{self.sector}"

    def contains(self, lat: float, lon: float, altitude_ft: Optional[float] = None) -> bool:
        """True if the point (and optional altitude) falls in any part."""
        return any(v.contains(lat, lon, altitude_ft) for v in self.volumes)

    def bbox(self) -> Optional[Tuple[float, float, float, float]]:
        """Bounding box as ``(min_lat, min_lon, max_lat, max_lon)``."""
        lons: List[float] = []
        lats: List[float] = []
        for v in self.volumes:
            for lon, lat in v.ring:
                lons.append(lon)
                lats.append(lat)
        if not lons:
            return None
        return (min(lats), min(lons), max(lats), max(lons))


# Pull "BASE" / "MAX_ALT" rows out of the description HTML table. The table
# renders as "<td>BASE</td><td>35000</td>"; a forgiving regex avoids a full
# HTML parse for two integers.
_ALT_ROW_RE = re.compile(
    r'<td>\s*(BASE|MAX_ALT)\s*</td>\s*<td>\s*(\d+)\s*</td>',
    re.IGNORECASE,
)
# FolderPath row ends in the long sector designator, e.g. ".../ZTL/Ultra High (11)/00201".
_FOLDERPATH_RE = re.compile(
    r'<td>\s*FolderPath\s*</td>\s*<td>\s*([^<]+?)\s*</td>',
    re.IGNORECASE,
)


def _parse_description(desc: Optional[str]) -> Tuple[Optional[int], Optional[int], Optional[str]]:
    """Return ``(floor_ft, ceiling_ft, designator)`` parsed from a placemark
    description CDATA, any of which may be ``None`` if not present."""
    if not desc:
        return None, None, None
    floor_ft: Optional[int] = None
    ceiling_ft: Optional[int] = None
    for label, value in _ALT_ROW_RE.findall(desc):
        if label.upper() == 'BASE':
            floor_ft = int(value)
        else:
            ceiling_ft = int(value)
    designator: Optional[str] = None
    m = _FOLDERPATH_RE.search(desc)
    if m:
        tail = m.group(1).rstrip('/').rsplit('/', 1)[-1].strip()
        if tail:
            designator = tail
    return floor_ft, ceiling_ft, designator


def _facility_and_stratum(feature_layer_name: Optional[str]) -> Tuple[Optional[str], Optional[str]]:
    """Derive ``(facility, stratum)`` from a FeatureLayer folder name like
    ``ZTL_ULTRA_03-07-23`` -> ``("ZTL", "ULTRA")``."""
    if not feature_layer_name:
        return None, None
    parts = feature_layer_name.split('_')
    facility = parts[0].upper() if parts and parts[0] else None
    stratum = parts[1].upper() if len(parts) > 1 and parts[1] else None
    return facility, stratum


def _extract_rings(placemark: ET.Element) -> List[List[Tuple[float, float]]]:
    """Collect every coordinate ring in a placemark.

    Handles both ``<Polygon>`` outer rings and ``<LineString>`` (closed),
    whether or not they're wrapped in ``<MultiGeometry>``. We simply gather all
    ``<coordinates>`` elements: for the AllSectors KML each placemark's
    geometry is one ring, but a few use MultiGeometry with several.
    """
    rings: List[List[Tuple[float, float]]] = []
    for el in placemark.iter():
        if _localname(el.tag) != 'coordinates':
            continue
        if not el.text:
            continue
        ring = _parse_coordinates(el.text)
        if len(ring) >= 3:
            # Ensure the ring is closed so ray-casting is well-defined.
            if ring[0] != ring[-1]:
                ring.append(ring[0])
            rings.append(ring)
    return rings


class KMLSectorIndex:
    """Lookup of parsed :class:`SectorBoundary` objects keyed by ``FAC/SEC``."""

    def __init__(self, sectors: Dict[str, SectorBoundary]):
        self._sectors = sectors

    def __len__(self) -> int:
        return len(self._sectors)

    def keys(self) -> List[str]:
        return list(self._sectors.keys())

    def get(self, facility: str, sector: str) -> Optional[SectorBoundary]:
        """Look up a sector by facility + sector id (case-insensitive).

        Matches on the short sector name first, then the long designator, so
        either ``ZTL/2`` or ``ZTL/00201`` resolves to the same volume.
        """
        fac = (facility or '').strip().upper()
        sec = (sector or '').strip().upper()
        direct = self._sectors.get(f"{fac}/{sec}")
        if direct:
            return direct
        for boundary in self._sectors.values():
            if boundary.facility == fac and (
                boundary.designator and boundary.designator.upper() == sec
            ):
                return boundary
        return None

    def facilities(self) -> List[str]:
        return sorted({b.facility for b in self._sectors.values() if b.facility})

    def sectors_for(self, facility: str) -> List[SectorBoundary]:
        fac = (facility or '').strip().upper()
        return [b for b in self._sectors.values() if b.facility == fac]


def parse_sectors_kml(path: str | Path) -> KMLSectorIndex:
    """Parse an AllSectors-style KML into a :class:`KMLSectorIndex`.

    Multi-part sectors (multiple placemarks sharing facility + sector) are
    unioned. Volumes carry altitude floor/ceiling from the description when
    present.
    """
    path = Path(path)
    if not path.exists():
        raise FileNotFoundError(f"KML file not found: {path}")

    logger.info(f"Parsing sector KML: {path}")
    tree = ET.parse(str(path))
    root = tree.getroot()

    sectors: Dict[str, SectorBoundary] = {}
    placemark_count = 0
    skipped = 0

    def walk(element: ET.Element, current_facility: Optional[str],
             current_stratum: Optional[str]) -> None:
        nonlocal placemark_count, skipped
        for child in element:
            tag = _localname(child.tag)
            if tag == 'Folder':
                # A FeatureLayer folder (the deepest one) names the facility +
                # stratum; carry it down to the placemarks it contains.
                name_el = child.find('./{*}name')
                folder_name = name_el.text.strip() if name_el is not None and name_el.text else None
                fac, strat = _facility_and_stratum(folder_name)
                # Only override when the folder name actually looks like a
                # facility layer (e.g. "ZTL_ULTRA_…"); region/ARTCC display
                # folders (EASTERN, ATLANTA) leave the context unchanged.
                if fac and re.match(r'^[A-Z]{3}_', (folder_name or '').upper()):
                    walk(child, fac, strat)
                else:
                    walk(child, current_facility, current_stratum)
            elif tag == 'Document':
                walk(child, current_facility, current_stratum)
            elif tag == 'Placemark':
                placemark_count += 1
                _add_placemark(child, current_facility, current_stratum)
            else:
                # Descend through any other container just in case.
                if len(child):
                    walk(child, current_facility, current_stratum)

    def _add_placemark(placemark: ET.Element, facility: Optional[str],
                       stratum: Optional[str]) -> None:
        nonlocal skipped
        name_el = placemark.find('./{*}name')
        sector_name = name_el.text.strip() if name_el is not None and name_el.text else None
        desc_el = placemark.find('./{*}description')
        desc = desc_el.text if desc_el is not None else None
        floor_ft, ceiling_ft, designator = _parse_description(desc)

        if not facility or not sector_name:
            skipped += 1
            return

        rings = _extract_rings(placemark)
        if not rings:
            skipped += 1
            return

        fac = facility.upper()
        sec = sector_name.upper()
        key = f"{fac}/{sec}"
        boundary = sectors.get(key)
        if boundary is None:
            boundary = SectorBoundary(
                facility=fac, sector=sec,
                designator=designator, stratum=stratum,
            )
            sectors[key] = boundary
        elif designator and not boundary.designator:
            boundary.designator = designator

        for ring in rings:
            boundary.volumes.append(
                SectorVolume(ring=ring, floor_ft=floor_ft, ceiling_ft=ceiling_ft)
            )

    walk(root, None, None)

    logger.info(
        f"Parsed {len(sectors)} sectors from {placemark_count} placemarks "
        f"({skipped} skipped, no facility/geometry)"
    )
    return KMLSectorIndex(sectors)
