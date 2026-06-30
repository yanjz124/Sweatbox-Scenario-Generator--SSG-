"""
Live Replay scenario.

Turns a capture file (produced by ``utils.live_capture``) into a list of
:class:`models.aircraft.Aircraft` that spawn at each aircraft's real captured
position/altitude and fly the remainder of their filed route. Spawn timing
reproduces the real session: ``spawnDelay`` = the offset at which each aircraft
first entered the sector.

vNAS placement: positions are expressed as a fix-radial-distance (FRD) off the
nearest waypoint on the aircraft's route (``RouteParser.generate_frd_position``)
and fed to a ``FixOrFrd`` starting condition with a ``navigationPath`` made of
the downstream route fixes — vNAS doesn't accept raw lat/lon spawns. This mirrors
how ``ArtccEnrouteScenario`` places transient aircraft, but here the position is
the *observed* one rather than a synthesized boundary-entry point.
"""
from __future__ import annotations

import json
import logging
import math
from pathlib import Path
from typing import Dict, List, Optional

from models.aircraft import Aircraft
from utils.route_positioning import RouteParser

logger = logging.getLogger(__name__)


def _to_int(v) -> Optional[int]:
    if v is None:
        return None
    try:
        return int(round(float(v)))
    except (TypeError, ValueError):
        return None


def _norm_sec(s) -> str:
    """Match the capture-side sector normalization (uppercase, strip non-alnum
    and leading zeros) so 7 == 07."""
    import re
    t = re.sub(r"[^A-Za-z0-9]", "", str(s or "")).upper().lstrip("0")
    return t or "0"


class LiveReplayScenario:
    """Build aircraft from a captured sector snapshot."""

    def __init__(self, capture: Dict, hold_initial_altitude: bool = False):
        self.capture = capture or {}
        self.facility = (self.capture.get("facility") or "").upper() or None
        self.sector = self.capture.get("sector")
        self.hold_initial_altitude = hold_initial_altitude
        self.route_parser = RouteParser()
        self.warnings: List[str] = []
        self.generation_stats: Dict = {}

        # Fake-ATC: map each captured controllingSector -> a vNAS positionId
        # (supports combining: many sectors -> one position) with an optional
        # fallback. Keys normalized so 7 == 07.
        atc = self.capture.get("atcConfig") or {}
        self.atc_enabled = bool(atc.get("enabled"))
        self.sector_to_position = {
            _norm_sec(k): v for k, v in (atc.get("sectorToPosition") or {}).items() if v
        }
        self.fallback_position = atc.get("fallbackPositionId") or None
        self.atc_handoff_from_timeline = bool(atc.get("handoffFromTimeline"))
        # Positions the trainee works: aircraft owned by these keep ownership but
        # get NO auto-handoff (the trainee does their own in/out handoffs).
        self.trainee_positions = set(atc.get("traineePositionIds") or [])

    @classmethod
    def from_file(cls, path: str | Path, **kwargs) -> "LiveReplayScenario":
        data = json.loads(Path(path).read_text("utf-8"))
        return cls(data, **kwargs)

    # ── public API ────────────────────────────────────────────────────────────
    def generate(self) -> List[Aircraft]:
        entries = self.capture.get("aircraft", [])
        aircraft: List[Aircraft] = []
        skipped = {"no_position": 0, "no_route": 0, "no_frd": 0, "no_type": 0}

        for entry in entries:
            ac, reason = self._aircraft_from_entry(entry)
            if ac is not None:
                aircraft.append(ac)
            elif reason in skipped:
                skipped[reason] += 1

        self.generation_stats = {
            "requested_total": len(entries),
            "actual_total": len(aircraft),
            "skipped": skipped,
            "facility": self.facility,
            "sector": self.sector,
        }
        if len(aircraft) < len(entries):
            msg = (
                f"Live replay produced {len(aircraft)}/{len(entries)} aircraft "
                f"(skipped: {self.generation_stats['skipped']})"
            )
            logger.warning(msg)
            self.warnings.append(msg)
        else:
            logger.info(f"Live replay produced {len(aircraft)} aircraft for {self.facility}/{self.sector}")
        return aircraft

    # ── per-aircraft conversion ────────────────────────────────────────────────
    def _aircraft_from_entry(self, entry: Dict):
        spawn = entry.get("spawn") or {}
        fp = entry.get("flightplan") or {}

        lat = spawn.get("lat")
        lon = spawn.get("lon")
        if lat is None or lon is None:
            return None, "no_position"

        route_str = (fp.get("route") or "").strip()
        if not route_str:
            return None, "no_route"

        waypoints = self.route_parser.parse_route_string(route_str)
        route_coords = self.route_parser.get_route_waypoint_coordinates(waypoints)
        if not route_coords:
            # Can't anchor an FRD without at least one resolvable route fix.
            return None, "no_frd"

        frd = self.route_parser.generate_frd_position(lat, lon, route_coords)
        if not frd:
            return None, "no_frd"

        destination = fp.get("destination") or ""
        nav_path = self._downstream_route(route_coords, lat, lon, destination)

        # Never fake the aircraft type — skip if SWIM hadn't published it yet
        # (the editor can set it to recover the aircraft).
        type_raw = (entry.get("aircraftType") or "").strip()
        if not type_raw:
            return None, "no_type"
        aircraft_type = self._with_equipment_suffix(type_raw)

        # Spawn at the FILED flight-plan altitude (cruise), not the live/current
        # altitude — so aircraft appear at cruise, not mid-climb.
        fp_alt = _to_int(fp.get("cruiseAltitudeFt")) or _to_int(fp.get("assignedAltitudeFt"))
        spawn_alt = fp_alt or _to_int(spawn.get("altitudeFt")) or 35000
        cruise_alt = fp_alt or spawn_alt

        ground_speed = _to_int(spawn.get("groundSpeedKt")) or 0
        cruise_speed = _to_int(fp.get("cruiseSpeedKt"))

        rules = (entry.get("flightRules") or "I").strip().upper()
        flight_rules = "V" if rules.startswith("V") else "I"

        offset = entry.get("firstSeenOffsetSec")
        spawn_delay = max(0, int(offset)) if offset is not None else None

        aircraft = Aircraft(
            callsign=(entry.get("callsign") or "").strip(),
            aircraft_type=aircraft_type,
            latitude=float(lat),
            longitude=float(lon),
            altitude=int(spawn_alt),
            # Heading left for vNAS to derive from the first navigationPath fix
            # (mirrors ArtccEnrouteScenario — supplying a heading caused wrong-
            # way spawns when magnetic/db coords disagreed).
            heading=0,
            ground_speed=ground_speed,
            starting_conditions_type="FixOrFrd",
            fix=frd,
            departure=fp.get("departure") or "",
            arrival=destination,
            route=route_str,
            # Only fixes AHEAD of the aircraft (or the destination). Never fall
            # back to the full route_str — that starts behind them and makes
            # them turn around to the first fix.
            navigation_path=nav_path or destination or "",
            cruise_altitude=str(cruise_alt) if cruise_alt is not None else None,
            cruise_speed=cruise_speed,
            flight_rules=flight_rules,
            wake_turbulence=entry.get("wake"),
            star=fp.get("star"),
            remarks=fp.get("remarks"),
            spawn_delay=spawn_delay,
            difficulty="Easy",
        )

        # Fake ATC: bind the aircraft to its sector's vNAS position (combine /
        # fallback applied). The converter emits autoTrackConditions from this.
        if self.atc_enabled:
            sec = (entry.get("entry") or {}).get("controllingSector") or ""
            posid = self.sector_to_position.get(_norm_sec(sec)) or self.fallback_position
            if posid:
                aircraft.auto_track_position_id = posid
                # Auto-handoff timing from the captured timeline — but NOT for
                # the trainee's own positions (they handle their handoffs).
                if self.atc_handoff_from_timeline and posid not in self.trainee_positions:
                    hos = entry.get("handoffs") or []
                    if hos and hos[0].get("atOffsetSec") is not None:
                        delay = int(hos[0]["atOffsetSec"]) - int(entry.get("firstSeenOffsetSec") or 0)
                        if delay > 0:
                            aircraft.auto_track_handoff_delay = delay

        return aircraft, None

    # ── helpers ─────────────────────────────────────────────────────────────────
    @staticmethod
    def _with_equipment_suffix(aircraft_type: str) -> str:
        """Append /L for airline jets if no equipment suffix is present
        (mirrors BaseScenario._add_equipment_suffix). Wake prefix is applied
        downstream by the vNAS converter."""
        if "/" in aircraft_type:
            return aircraft_type
        return f"{aircraft_type}/L"

    def _downstream_route(self, route_coords, lat: float, lon: float,
                          destination: str) -> str:
        """Build the navigationPath: route fixes from the next one ahead of the
        aircraft to the end, then the destination.

        The "next fix" is the end of the route segment the aircraft is currently
        on, found by projecting its position onto each segment (equirectangular
        approximation, fine at sector scale)."""
        n = len(route_coords)
        if n == 0:
            return destination or ""
        if n == 1:
            # Only one resolvable fix — we can't tell if it's ahead or behind,
            # so route direct to the destination (the FRD already fixes the
            # spawn position). Avoids turning back to a fix behind the aircraft.
            return destination or route_coords[0][0]

        next_idx = self._next_fix_index(route_coords, lat, lon)
        names = [nm for nm, _, _ in route_coords[next_idx:]]
        if destination:
            names.append(destination)
        nav = " ".join(names).strip()
        return nav or destination or ""

    @staticmethod
    def _next_fix_index(route_coords, lat: float, lon: float) -> int:
        """Index of the first route fix ahead of the aircraft.

        Projects the position onto each consecutive segment; the segment with
        the smallest perpendicular distance localizes the aircraft, and the next
        fix is that segment's end vertex. If the projection runs past the final
        vertex, returns ``len`` (beyond the route → caller falls back to dest)."""
        n = len(route_coords)
        coslat = math.cos(math.radians(lat))

        def xy(la, lo):
            return (math.radians(lo) * coslat, math.radians(la))

        px, py = xy(lat, lon)
        best_i = 0
        best_d = float("inf")
        best_t = 0.0
        for i in range(n - 1):
            _, la1, lo1 = route_coords[i]
            _, la2, lo2 = route_coords[i + 1]
            ax, ay = xy(la1, lo1)
            bx, by = xy(la2, lo2)
            abx, aby = bx - ax, by - ay
            denom = abx * abx + aby * aby
            t = 0.0 if denom == 0 else ((px - ax) * abx + (py - ay) * aby) / denom
            tc = max(0.0, min(1.0, t))
            cx, cy = ax + abx * tc, ay + aby * tc
            d = (px - cx) ** 2 + (py - cy) ** 2
            if d < best_d:
                best_d, best_i, best_t = d, i, t

        # Past the end of the last segment → beyond the route.
        if best_i == n - 2 and best_t > 1.0:
            return n
        return best_i + 1
