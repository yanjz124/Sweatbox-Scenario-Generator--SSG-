"""
Live capture client: record traffic in a target sector from SwimServer's
WebSocket feed over a time window, then write a capture file.

SwimServer (`ws://localhost:5001/ws`) sends, with camelCase keys:
  - {"type":"snapshot","data":[<flight summary>, ...]}   once on connect
  - {"type":"batch","data":[<flight summary>, ...]}       ~every 1s (changed)
  - {"type":"remove", ...}                                occasionally

Membership is **ownership-primary**: a flight is "in sector" when its
``controllingFacility``/``controllingSector`` match the target. When ownership
is absent we fall back to the KML polygon (:class:`parsers.kml_parser.SectorBoundary`).

We record each flight the first time it is observed in the sector. Its
``spawnDelay`` in the generated scenario is the offset (seconds) from capture
start to that first-seen moment — so the scenario rebuilds the way the real
session filled up. Flights already in the sector at connect time get offset 0.

The capture/membership logic lives in :class:`CaptureSession` (pure, unit-
testable with synthetic messages); :class:`SwimCaptureClient` only drives the
socket loop.
"""
from __future__ import annotations

import json
import logging
import re
import threading
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, Dict, List, Optional

logger = logging.getLogger(__name__)

CAPTURE_FILE_VERSION = 1


def _norm_sector(s: Optional[str]) -> str:
    """Normalize a sector id for comparison: uppercase, drop non-alphanumerics,
    strip leading zeros (so ``02`` == ``2``). Keeps trailing letters (``30R``)."""
    if not s:
        return ""
    s = re.sub(r"[^A-Za-z0-9]", "", s).upper()
    s = s.lstrip("0")
    return s or "0"


def _num(v) -> Optional[float]:
    """Coerce a possibly-None/str numeric to float, or None."""
    if v is None:
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


@dataclass
class CapturedAircraft:
    """One aircraft's first-seen-in-sector snapshot, extracted from a SwimServer
    flight summary into a stable shape for the capture file."""
    gufi: str
    callsign: str
    first_seen_offset_sec: int
    membership_basis: str  # 'ownership' | 'geometry' | 'vicinity'
    category: str = "sector"  # 'sector' (owned) | 'vicinity' (nearby)
    # Ownership/handoff timeline observed during the capture window:
    # [{atOffsetSec, fromFacility, fromSector, toFacility, toSector}, ...]
    handoffs: List[Dict] = field(default_factory=list)
    # Clearance changes observed during the window (for timed replay):
    # [{atOffsetSec, kind: 'alt'|'interim'|'speed'|'heading', value}, ...]
    clearance_events: List[Dict] = field(default_factory=list)
    aircraft_type: Optional[str] = None
    wake: Optional[str] = None
    flight_rules: Optional[str] = None
    # spawn state
    lat: Optional[float] = None
    lon: Optional[float] = None
    spawn_altitude_ft: Optional[int] = None
    ground_speed_kt: Optional[int] = None
    # flight plan
    origin: Optional[str] = None
    destination: Optional[str] = None
    route: Optional[str] = None
    original_route: Optional[str] = None
    star: Optional[str] = None
    cruise_altitude_ft: Optional[int] = None
    assigned_altitude_ft: Optional[int] = None
    interim_altitude_ft: Optional[int] = None
    block_floor_ft: Optional[int] = None
    block_ceiling_ft: Optional[int] = None
    cruise_speed_kt: Optional[int] = None
    # Controller-issued instructions (ERAM 4th-line / datablock), so the replay
    # can have the fake ATC re-issue them and the AI pilots execute.
    clearance_heading: Optional[str] = None
    clearance_speed: Optional[str] = None
    clearance_text: Optional[str] = None
    fourth_line: Optional[str] = None
    pointout_from: Optional[str] = None
    pointout_to: Optional[str] = None
    remarks: Optional[str] = None
    equipment: Optional[str] = None
    # entry context (for debugging / fidelity)
    controlling_facility: Optional[str] = None
    controlling_sector: Optional[str] = None

    @staticmethod
    def from_summary(flight: dict, offset_sec: int, basis: str) -> "CapturedAircraft":
        reported = _num(flight.get("reportedAltitude"))
        assigned = _num(flight.get("assignedAltitude"))
        requested = _num(flight.get("requestedAltitude"))
        spawn_alt = reported if reported is not None else (assigned if assigned is not None else requested)
        cruise_alt = requested if requested is not None else assigned
        gs = _num(flight.get("groundSpeed"))
        spd = _num(flight.get("requestedSpeed"))

        def _int(x):
            return int(round(x)) if x is not None else None

        return CapturedAircraft(
            gufi=flight.get("gufi") or "",
            callsign=(flight.get("callsign") or "").strip(),
            first_seen_offset_sec=offset_sec,
            membership_basis=basis,
            aircraft_type=flight.get("aircraftType"),
            wake=flight.get("wakeCategory"),
            flight_rules=flight.get("flightRules"),
            lat=_num(flight.get("latitude")),
            lon=_num(flight.get("longitude")),
            spawn_altitude_ft=_int(spawn_alt),
            ground_speed_kt=_int(gs),
            origin=flight.get("origin"),
            destination=flight.get("destination"),
            # Keep BOTH: the active route can be expanded to bare fixes, while the
            # filed originalRoute usually retains procedure names (SID/STAR/airways).
            # The replay picks whichever is more "procedural".
            route=flight.get("route"),
            original_route=flight.get("originalRoute"),
            star=flight.get("star"),
            cruise_altitude_ft=_int(cruise_alt),
            assigned_altitude_ft=_int(assigned),
            interim_altitude_ft=_int(_num(flight.get("interimAltitude"))),
            block_floor_ft=_int(_num(flight.get("blockFloor"))),
            block_ceiling_ft=_int(_num(flight.get("blockCeiling"))),
            cruise_speed_kt=_int(spd),
            clearance_heading=(flight.get("clearanceHeading") or None),
            clearance_speed=(flight.get("clearanceSpeed") or None),
            clearance_text=(flight.get("clearanceText") or None),
            fourth_line=(flight.get("fourthAdaptedField") or None),
            pointout_from=(flight.get("pointoutOriginatingUnit") or None),
            pointout_to=(flight.get("pointoutReceivingUnit") or None),
            remarks=flight.get("remarks"),
            equipment=flight.get("equipmentQualifier"),
            controlling_facility=flight.get("controllingFacility"),
            controlling_sector=flight.get("controllingSector"),
        )


class CaptureSession:
    """Pure capture-state machine. Feed it parsed WS messages with the elapsed
    offset; it tracks who is in the sector and records first-entries.

    A flight must have a usable filed route and position to be recordable — an
    aircraft with no route can't fly a replay, and one with no lat/lon can't be
    placed. Such flights are counted in ``skipped`` for diagnostics.
    """

    def __init__(self, facility: str, sector: Optional[str] = None, boundary=None,
                 require_route: bool = True, vicinity_nm: float = 0.0):
        self.facility = (facility or "").strip().upper()
        raw = (sector or "").strip()
        # Empty / "ALL" => whole facility. Otherwise a comma-separated list of
        # sectors, e.g. "60, 72, 7" (leading zeros don't matter: 7 == 07).
        self.facility_wide = raw == "" or raw.upper() == "ALL"
        if self.facility_wide:
            self.sector_set = None
        else:
            self.sector_set = {_norm_sector(s) for s in raw.split(",") if s.strip()}
            if not self.sector_set:
                self.facility_wide = True
                self.sector_set = None
        self.sector_raw = raw.upper()
        # boundary may be a single SectorBoundary, a list of them (facility-
        # wide geometry fallback), or None.
        if boundary is None:
            self._boundaries = []
        elif isinstance(boundary, list):
            self._boundaries = [b for b in boundary if b is not None]
        else:
            self._boundaries = [boundary]
        self.require_route = require_route

        # gufi -> CapturedAircraft (first entry wins)
        self.recorded: Dict[str, CapturedAircraft] = {}
        # gufis currently observed inside the sector (to detect new entries)
        self._inside: set = set()
        # diagnostics
        self.skipped_no_route = 0
        self.skipped_no_position = 0
        self.seen_sectors: Dict[str, int] = {}  # "FAC/SEC" -> obs count
        # Sectors in OUR facility seen owning ≥1 flight = "active sectors".
        self.facility_sectors_seen: set = set()
        self.recorded_by_sector: Dict[str, int] = {}
        # gufi -> last observed (facility, sector), for handoff-transition logging
        self._last_owner: Dict[str, tuple] = {}
        # gufi -> last observed clearance dict, for change detection (timed replay)
        self._last_clr: Dict[str, dict] = {}
        self._max_handoffs = 30  # cap per aircraft to avoid bloat
        self._max_events = 60    # cap clearance events per aircraft

        # Vicinity region: bbox of the selected sector polygons, expanded by
        # vicinity_nm. Nearby (non-owned) traffic inside it is captured and
        # tagged 'vicinity' so the editor can optionally include it.
        self.vicinity_nm = float(vicinity_nm or 0)
        self.vicinity_bbox = None
        if self.vicinity_nm > 0 and self._boundaries:
            lats: List[float] = []
            lons: List[float] = []
            for b in self._boundaries:
                bb = b.bbox()  # (min_lat, min_lon, max_lat, max_lon)
                if bb:
                    lats += [bb[0], bb[2]]
                    lons += [bb[1], bb[3]]
            if lats:
                import math
                mn_lat, mx_lat = min(lats), max(lats)
                mn_lon, mx_lon = min(lons), max(lons)
                dlat = self.vicinity_nm / 60.0
                dlon = self.vicinity_nm / 60.0 / max(0.1, math.cos(math.radians((mn_lat + mx_lat) / 2)))
                self.vicinity_bbox = (mn_lat - dlat, mn_lon - dlon, mx_lat + dlat, mx_lon + dlon)

    def membership_basis(self, flight: dict) -> Optional[str]:
        """Return 'ownership' / 'geometry' if the flight is in the target
        sector, else None."""
        fac = (flight.get("controllingFacility") or "").strip().upper()
        sec = (flight.get("controllingSector") or "").strip()

        if fac and sec:
            # Diagnostic tally of every owned sector we see (any facility).
            self.seen_sectors[f"{fac}/{sec}"] = self.seen_sectors.get(f"{fac}/{sec}", 0) + 1
            if fac == self.facility:
                # An active sector in our facility (owns ≥1 flight).
                self.facility_sectors_seen.add(sec.upper())
                if self.facility_wide or _norm_sector(sec) in self.sector_set:
                    return "ownership"
            # Owned by another facility/sector — fall through to vicinity.
        elif self._boundaries:
            # No ownership: geometry fallback — inside our sector polygon = ours.
            lat = _num(flight.get("latitude"))
            lon = _num(flight.get("longitude"))
            if lat is not None and lon is not None:
                alt = _num(flight.get("reportedAltitude")) or _num(flight.get("assignedAltitude"))
                if any(b.contains(lat, lon, alt) for b in self._boundaries):
                    return "geometry"

        # Vicinity: nearby traffic (not ours) within the expanded bbox.
        if self.vicinity_bbox is not None:
            lat = _num(flight.get("latitude"))
            lon = _num(flight.get("longitude"))
            if lat is not None and lon is not None:
                mn_lat, mn_lon, mx_lat, mx_lon = self.vicinity_bbox
                if mn_lat <= lat <= mx_lat and mn_lon <= lon <= mx_lon:
                    return "vicinity"
        return None

    def _recordable(self, flight: dict) -> bool:
        """Only record aircraft with a COMPLETE flight plan + position. On a
        cold-started SwimServer, positions stream before the flight plan
        (route/type/altitude) arrives — recording early produced fake B738s,
        missing routes, etc. Requiring the full plan defers each aircraft until
        its data is in (pairs with keeping the server warm before capturing)."""
        has_pos = _num(flight.get("latitude")) is not None and _num(flight.get("longitude")) is not None
        if not has_pos:
            self.skipped_no_position += 1
            return False
        if self.require_route:
            has_route = bool((flight.get("route") or flight.get("originalRoute") or "").strip())
            has_type = bool((flight.get("aircraftType") or "").strip())
            has_dest = bool((flight.get("destination") or "").strip())
            has_alt = (_num(flight.get("requestedAltitude")) is not None
                       or _num(flight.get("assignedAltitude")) is not None)
            if not (has_route and has_type and has_dest and has_alt):
                self.skipped_no_route += 1  # "incomplete plan" bucket
                return False
        return True

    def ingest(self, flight: dict, offset_sec: int) -> bool:
        """Process one flight summary at the given capture offset. Returns True
        if this call recorded a NEW first-entry."""
        gufi = flight.get("gufi")
        if not gufi:
            return False

        # For already-recorded aircraft, keep logging ownership changes
        # (handoffs) even after they leave our sector/facility — that's how we
        # capture inter-facility handoffs (e.g. ZJX66 → ZDC09).
        if gufi in self.recorded:
            self._track_handoff(gufi, flight, offset_sec)
            self._track_clearances(gufi, flight, offset_sec)
            return False

        basis = self.membership_basis(flight)
        if basis is None:
            self._inside.discard(gufi)
            return False

        # In-sector now. New entry?
        newly_inside = gufi not in self._inside
        self._inside.add(gufi)
        if not newly_inside:
            # Was already inside but not recorded (e.g. failed recordable check
            # earlier); allow a later retry once data is complete.
            pass
        if not self._recordable(flight):
            return False

        ac = CapturedAircraft.from_summary(flight, max(0, offset_sec), basis)
        ac.category = "vicinity" if basis == "vicinity" else "sector"
        self.recorded[gufi] = ac
        rsec = (flight.get("controllingSector") or "?").strip().upper() or "?"
        self.recorded_by_sector[rsec] = self.recorded_by_sector.get(rsec, 0) + 1
        # Seed the handoff tracker with the entry owner.
        self._last_owner[gufi] = (
            (flight.get("controllingFacility") or "").strip().upper(),
            (flight.get("controllingSector") or "").strip().upper(),
        )
        logger.debug(
            f"Captured {self.recorded[gufi].callsign} into {self.facility}/{rsec} "
            f"at +{offset_sec}s ({basis})"
        )
        return True

    def _track_handoff(self, gufi: str, flight: dict, offset_sec: int) -> None:
        """Append a handoff event when a recorded aircraft's controlling
        facility/sector changes."""
        fac = (flight.get("controllingFacility") or "").strip().upper()
        sec = (flight.get("controllingSector") or "").strip().upper()
        if not fac and not sec:
            return  # ignore transient blanks
        cur = (fac, sec)
        prev = self._last_owner.get(gufi)
        if prev == cur:
            return
        ac = self.recorded.get(gufi)
        if ac is not None and len(ac.handoffs) < self._max_handoffs:
            ac.handoffs.append({
                "atOffsetSec": max(0, int(offset_sec)),
                "fromFacility": (prev[0] if prev else None),
                "fromSector": (prev[1] if prev else None),
                "toFacility": fac,
                "toSector": sec,
                # Where the handoff happened (for location fidelity / reference).
                "lat": _num(flight.get("latitude")),
                "lon": _num(flight.get("longitude")),
                "altitudeFt": _num(flight.get("reportedAltitude")) or _num(flight.get("assignedAltitude")),
            })
        self._last_owner[gufi] = cur

    def _track_clearances(self, gufi: str, flight: dict, offset_sec: int) -> None:
        """Append an event whenever a recorded aircraft's assigned/interim
        altitude, clearance speed, or clearance heading changes — so the replay
        can issue each clearance as a timed command at the captured time."""
        cur = {
            "alt": _num(flight.get("assignedAltitude")),
            "interim": _num(flight.get("interimAltitude")),
            "speed": (flight.get("clearanceSpeed") or None),
            "heading": (flight.get("clearanceHeading") or None),
        }
        prev = self._last_clr.get(gufi)
        if prev is None:
            self._last_clr[gufi] = cur  # seed with the first-seen state (= spawn)
            return
        ac = self.recorded.get(gufi)
        if ac is not None:
            for kind in ("alt", "interim", "speed", "heading"):
                if cur[kind] is not None and cur[kind] != prev[kind] and len(ac.clearance_events) < self._max_events:
                    ac.clearance_events.append({
                        "atOffsetSec": max(0, int(offset_sec)),
                        "kind": kind,
                        "value": cur[kind],
                    })
        self._last_clr[gufi] = cur

    def ingest_message(self, msg: dict, offset_sec: int) -> int:
        """Process a whole WS message ({type,data}); return # new entries."""
        mtype = msg.get("type")
        data = msg.get("data")
        if mtype in ("snapshot", "batch") and isinstance(data, list):
            return sum(int(self.ingest(f, offset_sec)) for f in data if isinstance(f, dict))
        if mtype == "remove":
            # Drop from the inside-set so a later re-entry is detectable; keep
            # anything already recorded.
            gufis = []
            if isinstance(data, dict):
                gufis = [data.get("gufi")]
            elif isinstance(data, list):
                gufis = [d.get("gufi") if isinstance(d, dict) else d for d in data]
            for g in gufis:
                self._inside.discard(g)
        return 0


@dataclass
class CaptureResult:
    facility: str
    sector: str
    capture_start_iso: str
    window_sec: int
    aircraft: List[CapturedAircraft]
    boundary_kml: Optional[str] = None
    diagnostics: Dict = field(default_factory=dict)

    def to_dict(self) -> dict:
        return {
            "version": CAPTURE_FILE_VERSION,
            "source": "swimreader-sfdps",
            "facility": self.facility,
            "sector": self.sector,
            "captureStart": self.capture_start_iso,
            "windowSeconds": self.window_sec,
            "boundaryKml": self.boundary_kml,
            "diagnostics": self.diagnostics,
            "aircraft": [
                {
                    "gufi": a.gufi,
                    "callsign": a.callsign,
                    "firstSeenOffsetSec": a.first_seen_offset_sec,
                    "membershipBasis": a.membership_basis,
                    "category": a.category,
                    "aircraftType": a.aircraft_type,
                    "wake": a.wake,
                    "flightRules": a.flight_rules,
                    "spawn": {
                        "lat": a.lat,
                        "lon": a.lon,
                        "altitudeFt": a.spawn_altitude_ft,
                        "groundSpeedKt": a.ground_speed_kt,
                    },
                    "flightplan": {
                        "departure": a.origin,
                        "destination": a.destination,
                        "route": a.route,
                        "originalRoute": a.original_route,
                        "star": a.star,
                        "cruiseAltitudeFt": a.cruise_altitude_ft,
                        "assignedAltitudeFt": a.assigned_altitude_ft,
                        "cruiseSpeedKt": a.cruise_speed_kt,
                        "remarks": a.remarks,
                        "equipment": a.equipment,
                    },
                    "entry": {
                        "controllingFacility": a.controlling_facility,
                        "controllingSector": a.controlling_sector,
                    },
                    # Controller-issued instructions observed (ERAM 4th-line /
                    # datablock) — for the replay to re-issue via the fake ATC.
                    "clearances": {
                        "interimAltitudeFt": a.interim_altitude_ft,
                        "assignedAltitudeFt": a.assigned_altitude_ft,
                        "blockFloorFt": a.block_floor_ft,
                        "blockCeilingFt": a.block_ceiling_ft,
                        "heading": a.clearance_heading,
                        "speed": a.clearance_speed,
                        "text": a.clearance_text,
                        "fourthLine": a.fourth_line,
                        "pointoutFrom": a.pointout_from,
                        "pointoutTo": a.pointout_to,
                    },
                    "handoffs": a.handoffs,
                    "clearanceEvents": a.clearance_events,
                }
                for a in sorted(self.aircraft, key=lambda x: x.first_seen_offset_sec)
            ],
        }

    def write(self, path: str | Path) -> Path:
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(self.to_dict(), indent=2), encoding="utf-8")
        logger.info(f"Wrote capture file: {path} ({len(self.aircraft)} aircraft)")
        return path


class SwimCaptureClient:
    """Drives the SwimServer WebSocket and produces a :class:`CaptureResult`."""

    def __init__(self, facility: str, sector: Optional[str] = None,
                 host: str = "localhost", port: int = 5001,
                 boundary=None, boundary_kml_name: Optional[str] = None,
                 vicinity_nm: float = 0.0):
        self.facility = facility
        self.sector = sector
        self.host = host
        self.port = port
        self.boundary = boundary
        self.boundary_kml_name = boundary_kml_name
        self.vicinity_nm = vicinity_nm

    @property
    def ws_url(self) -> str:
        return f"ws://{self.host}:{self.port}/ws"

    def capture(self, window_sec: int,
                progress_callback: Optional[Callable[[float, int, int, int], None]] = None,
                stop_event: Optional[threading.Event] = None,
                recv_timeout: float = 1.0,
                autosave_path=None) -> CaptureResult:
        """Capture for ``window_sec`` seconds. ``progress_callback`` receives
        (elapsed_sec, window_sec, n_recorded, n_active_sectors) roughly once per
        second. ``stop_event`` lets a GUI cancel early. ``autosave_path`` (if set)
        gets the partial capture written every ~10s so a crash/disconnect never
        loses data."""
        try:
            import websocket  # websocket-client
        except ImportError as e:
            raise RuntimeError(
                "websocket-client is required for live capture. "
                "pip install websocket-client"
            ) from e

        session = CaptureSession(self.facility, self.sector, self.boundary,
                                 vicinity_nm=self.vicinity_nm)

        logger.info(
            f"Connecting to {self.ws_url} to capture {self.facility}/{self.sector} "
            f"for {window_sec}s"
        )
        ws = websocket.create_connection(self.ws_url, timeout=10)
        ws.settimeout(recv_timeout)

        capture_start = time.monotonic()
        capture_start_iso = datetime.now(timezone.utc).isoformat()
        last_progress = 0.0
        last_save = 0.0

        def build_result() -> CaptureResult:
            diagnostics = {
                "recorded": len(session.recorded),
                "skippedNoRoute": session.skipped_no_route,
                "skippedNoPosition": session.skipped_no_position,
                "activeSectorCount": len(session.facility_sectors_seen),
                "activeSectors": sorted(session.facility_sectors_seen),
                "recordedBySector": dict(
                    sorted(session.recorded_by_sector.items(), key=lambda kv: kv[1], reverse=True)
                ),
                "seenSectorsTop": dict(
                    sorted(session.seen_sectors.items(), key=lambda kv: kv[1], reverse=True)[:15]
                ),
            }
            return CaptureResult(
                facility=self.facility, sector=self.sector,
                capture_start_iso=capture_start_iso, window_sec=window_sec,
                aircraft=list(session.recorded.values()),
                boundary_kml=self.boundary_kml_name, diagnostics=diagnostics,
            )

        try:
            while True:
                elapsed = time.monotonic() - capture_start
                if elapsed >= window_sec:
                    break
                if stop_event is not None and stop_event.is_set():
                    logger.info("Capture cancelled by stop_event")
                    break

                try:
                    raw = ws.recv()
                except websocket.WebSocketTimeoutException:
                    raw = None
                except websocket.WebSocketConnectionClosedException:
                    logger.warning("SwimServer WebSocket closed during capture")
                    break

                if raw:
                    try:
                        msg = json.loads(raw)
                    except (ValueError, TypeError):
                        msg = None
                    if isinstance(msg, dict):
                        session.ingest_message(msg, int(round(elapsed)))

                if progress_callback and (elapsed - last_progress) >= 1.0:
                    last_progress = elapsed
                    progress_callback(
                        elapsed, window_sec, len(session.recorded),
                        len(session.facility_sectors_seen),
                    )

                # Incremental autosave so a crash/disconnect never loses data.
                if autosave_path and (elapsed - last_save) >= 10.0:
                    last_save = elapsed
                    try:
                        build_result().write(autosave_path)
                    except Exception as e:  # noqa: BLE001
                        logger.warning(f"capture autosave failed: {e}")
        finally:
            try:
                ws.close()
            except Exception:  # noqa: BLE001
                pass

        result = build_result()
        if not session.recorded:
            logger.warning(
                f"Capture recorded 0 aircraft for {self.facility}/{self.sector}. "
                f"Observed sectors: {result.diagnostics['seenSectorsTop']}"
            )
        if autosave_path:
            try:
                result.write(autosave_path)
            except Exception as e:  # noqa: BLE001
                logger.warning(f"capture final autosave failed: {e}")
        return result
