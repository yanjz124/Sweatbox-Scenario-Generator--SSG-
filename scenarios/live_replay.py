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
import re
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


_CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"


def _ulid() -> str:
    """Generate a ULID-shaped 26-char Crockford-base32 id (vNAS entity id)."""
    import os
    import time
    ts = int(time.time() * 1000) & ((1 << 48) - 1)
    head = ""
    for _ in range(10):
        head = _CROCKFORD[ts & 31] + head
        ts >>= 5
    tail = "".join(_CROCKFORD[b & 31] for b in os.urandom(16))[:16]
    return head + tail


def _icao_airport(code) -> str:
    """Coerce a flight-plan endpoint to a vNAS-acceptable ICAO airport (exactly
    four letters). 3-letter US codes get a 'K' prefix; anything with digits or
    the wrong length (FAA LIDs like 60J/4B6, fixes, DMEs) is dropped to '' —
    data-admin refuses to save a scenario containing a non-airport endpoint."""
    c = (code or "").strip().upper().split("/")[0]  # drop SWIM /TIME suffix (KDAL/1945)
    if len(c) == 3 and c.isalpha():
        c = "K" + c
    return c if (len(c) == 4 and c.isalpha()) else ""


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
        # Keyed by ownership identity FACILITY/SECTOR (uppercased) — a bare
        # sector isn't unique across the facility, neighbor ARTCCs, and TRACONs.
        self.owner_to_position = {
            str(k).upper(): v for k, v in (atc.get("sectorToPosition") or {}).items() if v
        }
        self.fallback_position = atc.get("fallbackPositionId") or None
        self.atc_handoff_from_timeline = bool(atc.get("handoffFromTimeline"))
        # Positions the trainee works: aircraft owned by these keep ownership but
        # get NO auto-handoff (the trainee does their own in/out handoffs). A
        # pseudo controller IS still spawned for them so their tracks are owned
        # at load — vNAS hands the seat to the trainee when they connect.
        self.trainee_positions = set(atc.get("traineePositionIds") or [])
        # Owner keys ("FAC/SEC") whose mapped position is a trainee seat — used to
        # detect which captured handoffs go TO the trainee (→ flash to student).
        self.trainee_owner_keys = {
            k for k, v in self.owner_to_position.items() if v in self.trainee_positions
        }
        # positionId -> {facilityId, artccId} metadata from the editor (facility
        # differs for center / TRACON / neighbor-ARTCC positions). The roster
        # itself is derived from the ACTUAL aircraft assignments in generate(),
        # so the fallback (and any combined/trainee position) is always staffed.
        self._atc_meta = {
            e.get("positionId"): e
            for e in (atc.get("atcEntries") or []) if e.get("positionId")
        }
        self.atc_roster: List[Dict] = []
        # STARS/TRACON positions auto-track by destination airport instead of
        # per-aircraft InitiateControl (which fails "ILL TRK" on enroute tracks).
        # positionId -> set of 3-letter airport ids to put in autoTrackAirportIds.
        self._stars_airports: Dict[str, set] = {}

    def _build_atc_roster(self, position_ids) -> List[Dict]:
        """One auto-connecting pseudo controller per position that owns a track:
        ERAM positions assigned per-aircraft (fallback + trainee included), PLUS
        STARS positions that auto-track by airport. Nothing loads unowned."""
        roster: List[Dict] = []
        # Staff every position the editor listed (all facility sectors + used
        # neighbor/TRACON positions), plus any actually-assigned/STARS positions —
        # so handoffs to quiet in-house sectors don't hit "SECTOR NOT ACTIVE".
        ids = list(self._atc_meta.keys()) + list(position_ids) + list(self._stars_airports.keys())
        for pid in dict.fromkeys(p for p in ids if p):  # dedupe, ordered
            # Trainee seat IS staffed by a ghost too (owns its tracks at load);
            # the student takes over that position when they sign in.
            meta = self._atc_meta.get(pid) or {}
            roster.append({
                "id": _ulid(),
                "artccId": meta.get("artccId") or self.facility,
                "facilityId": meta.get("facilityId") or meta.get("artccId") or self.facility,
                "positionId": pid,
                "autoConnect": True,
                "autoTrackAirportIds": sorted(self._stars_airports.get(pid, set())),
            })
        return roster

    @classmethod
    def from_file(cls, path: str | Path, **kwargs) -> "LiveReplayScenario":
        data = json.loads(Path(path).read_text("utf-8"))
        return cls(data, **kwargs)

    # ── public API ────────────────────────────────────────────────────────────
    def generate(self) -> List[Aircraft]:
        entries = self.capture.get("aircraft", [])
        aircraft: List[Aircraft] = []
        skipped = {"no_position": 0, "no_route": 0, "no_frd": 0, "no_type": 0, "dup_callsign": 0}

        # vNAS keys aircraft by callsign (AID) and rejects duplicates ("DUPLICATE
        # AID"). Keep the first occurrence (entries are ordered by first-seen).
        seen_callsigns: set = set()
        for entry in entries:
            ac, reason = self._aircraft_from_entry(entry)
            if ac is not None:
                cs = (ac.callsign or "").strip().upper()
                if cs in seen_callsigns:
                    skipped["dup_callsign"] += 1
                    continue
                seen_callsigns.add(cs)
                aircraft.append(ac)
            elif reason in skipped:
                skipped[reason] += 1

        # Staff every position an aircraft is actually auto-tracked to — this
        # guarantees the fallback and trainee positions get a controller, so no
        # track loads as "Position not found".
        if self.atc_enabled:
            self.atc_roster = self._build_atc_roster(
                [a.auto_track_position_id for a in aircraft if getattr(a, "auto_track_position_id", None)]
            )

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

        # Prefer the route that keeps procedure names (SID/STAR/airways) over the
        # one expanded to bare fixes — the filed originalRoute usually wins, but
        # not always, so pick the one with fewer ".." direct-to segments.
        route_active = (fp.get("route") or "").strip()
        route_filed = (fp.get("originalRoute") or "").strip()
        if route_filed and (not route_active or route_filed.count("..") < route_active.count("..")):
            route_str = route_filed
        else:
            route_str = route_active
        # SWIM annotates tokens with "/TIME" or "/speed-alt" (e.g. "KDAL/1945",
        # "FIX/N0450F350") — strip them so route fixes + the destination parse.
        route_str = re.sub(r"/\S+", "", route_str).strip()
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

        # vNAS / data-admin requires dep & dest to be real ICAO airports — drop
        # FAA LIDs / fixes / DMEs to '' (they block the whole scenario save).
        departure = _icao_airport(fp.get("departure"))
        destination = _icao_airport(fp.get("destination"))
        nav_path = self._downstream_route(route_coords, lat, lon, destination)

        # Never fake the aircraft type — skip if SWIM hadn't published it yet
        # (the editor can set it to recover the aircraft).
        type_raw = (entry.get("aircraftType") or "").strip()
        if not type_raw:
            return None, "no_type"
        aircraft_type = self._with_equipment_suffix(type_raw)

        # Spawn at the aircraft's ACTUAL (reported) altitude so the climb/descent
        # profile replays — onAltitudeProfile + any captured altitude clearance
        # flies it to its assigned/cruise level. Fall back to filed cruise.
        fp_alt = _to_int(fp.get("cruiseAltitudeFt")) or _to_int(fp.get("assignedAltitudeFt"))
        spawn_alt = _to_int(spawn.get("altitudeFt")) or fp_alt or 35000
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
            departure=departure,
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
            # SWIM prefixes remarks with a "|" field separator — strip it.
            remarks=((fp.get("remarks") or "").lstrip("| ").strip() or None),
            spawn_delay=spawn_delay,
            difficulty="Easy",
        )

        # Fake ATC: bind the aircraft to its sector's vNAS position (combine /
        # fallback applied). The converter emits autoTrackConditions from this.
        if self.atc_enabled:
            ent = entry.get("entry") or {}
            okey = f"{(ent.get('controllingFacility') or '').upper()}/{(ent.get('controllingSector') or '').upper()}"
            posid = self.owner_to_position.get(okey) or self.fallback_position
            if posid:
                is_trainee = posid in self.trainee_positions
                is_stars = bool((self._atc_meta.get(posid) or {}).get("isStars"))
                if is_stars and not is_trainee:
                    # STARS/TRACON can't InitiateControl an enroute-positioned
                    # track (ILL TRK). It auto-tracks by destination airport — but
                    # ONLY airports it controls (else vNAS errors "not controlled").
                    # Aircraft going elsewhere (transiting) fall to the enroute
                    # fallback instead.
                    controlled = set((self._atc_meta.get(posid) or {}).get("airports") or [])
                    apt = self._airport3(destination)
                    if apt and apt in controlled:
                        self._stars_airports.setdefault(posid, set()).add(apt)
                    elif self.fallback_position:
                        aircraft.auto_track_position_id = self.fallback_position
                else:
                    # Own the track with its sector's ghost. Handoffs then happen
                    # NORMALLY — vNAS ghosts hand off to each other by airspace as
                    # aircraft cross sectors, including to the trainee position's
                    # ghost; the student signs into that position and receives them.
                    # (No handoffDelay-to-student, which needs a student designated
                    # in the scenario and otherwise errors "student must be specified".)
                    aircraft.auto_track_position_id = posid
                # Re-issue captured controller instructions (AI executes them) —
                # NOT for the trainee's own sector, and only when AIRBORNE. A CM on
                # a ground aircraft errors ("can not climb/descend on the ground"),
                # and ground speed alone isn't enough (taxi/takeoff roll have speed
                # but are still on the ground) — also require some altitude.
                airborne = ground_speed >= 40 and spawn_alt >= 1500
                on_arrival = bool((fp.get("star") or "").strip())
                first = int(entry.get("firstSeenOffsetSec") or 0)
                cmds: List[str] = []
                if not is_trainee:
                    timed: List[tuple] = []  # (offsetSec, command)
                    # 1) Initial clearance at spawn (airborne only — a CM on the
                    #    ground errors).
                    if airborne:
                        init_cmds, scratch = self._clearance_commands(
                            entry.get("clearances") or {}, cruise_alt, on_arrival=on_arrival,
                        )
                        for c in init_cmds:
                            timed.append((0, c))
                        if scratch:
                            aircraft.auto_track_scratchpad = scratch
                    # 2) Timed clearance CHANGES (alt/speed/heading) at the times
                    #    they happened — "all commands done as WAIT".
                    for ev in (entry.get("clearanceEvents") or []):
                        if ev.get("atOffsetSec") is None:
                            continue
                        c = self._event_command(ev)
                        if c:
                            timed.append((max(0, int(ev["atOffsetSec"]) - first), c))
                    # 3) Full handoff chain, timed — to ANY facility (in-house,
                    #    neighbor ARTCC, TRACON), targeting the next sector by its
                    #    POSITION ID (universal; no adaptation codes). Each owning
                    #    ghost flashes at the captured time; AI ghosts auto-accept,
                    #    the trainee accepts the one to their sector. Only sectors
                    #    we staffed (have a position) can be targeted.
                    for h in (entry.get("handoffs") or []):
                        if h.get("atOffsetSec") is None:
                            continue
                        to_key = f"{(h.get('toFacility') or '').upper()}/{(h.get('toSector') or '').upper()}"
                        target = self.owner_to_position.get(to_key)
                        if target:
                            timed.append((max(0, int(h["atOffsetSec"]) - first), f"HO {target}"))
                    # Emit in chronological order; t=0 immediate, rest as WAIT.
                    timed.sort(key=lambda x: x[0])
                    cmds = [c if t == 0 else f"WAIT {t} {c}" for t, c in timed]
                if cmds:
                    aircraft.preset_commands = cmds

        return aircraft, None

    def _event_command(self, ev: Dict) -> Optional[str]:
        """A timed clearance event -> a vNAS command (no WAIT prefix)."""
        kind = ev.get("kind")
        val = ev.get("value")
        if kind in ("alt", "interim"):
            n = _to_int(val)
            return f"CM {self._alt_token(n)}" if n else None
        if kind == "speed":
            return self._speed_command(val)
        if kind == "heading":
            t = self._heading_token(val)
            return f"FH {t}" if t else None
        return None

    @staticmethod
    def _handoff_code(sector) -> str:
        """ERAM handoff target code for a sector — e.g. sector 33 -> "T33"
        (matches the `HO t33` form that works in CRC/ATCTrainer)."""
        s = re.sub(r"[^0-9A-Za-z]", "", str(sector or "")).upper()
        return f"T{s}" if s else ""

    @staticmethod
    def _airport3(icao) -> str:
        """vNAS airport ids are 3-letter FAA (DCA, IAD) — strip the K from a
        4-letter US ICAO. Non-US 4-letter codes are dropped (TRACONs are US)."""
        c = (icao or "").strip().upper()
        if len(c) == 4 and c.startswith("K") and c[1:].isalpha():
            return c[1:]
        if len(c) == 3 and c.isalpha():
            return c
        return ""

    # ── captured-clearance replay ───────────────────────────────────────────────
    def _clearance_commands(self, clr: Dict, cruise_alt, on_arrival: bool = False) -> tuple:
        """Translate a captured ERAM 4th-line / datablock clearance into vNAS
        sweatbox commands the AI pilot executes (DVIA/CM/SPD/MACH/FH) + a
        scratchpad."""
        import re
        cmds: List[str] = []

        # Altitude command (= the aircraft's command/assigned altitude at spawn):
        #  • arrivals on a STAR → DVIA (descend via, honoring crossing restrictions),
        #    bottoming at the captured interim/assigned altitude if any;
        #  • a captured interim/temp altitude → CM to that level-off;
        #  • otherwise → CM to the filed CRUISE (requested) altitude, so traffic
        #    captured mid-climb/descent continues to its filed altitude instead of
        #    stalling at the spawn altitude.
        interim = _to_int(clr.get("interimAltitudeFt"))
        assigned = _to_int(clr.get("assignedAltitudeFt"))
        if on_arrival:
            target = interim or assigned
            cmds.append(f"DVIA {self._alt_token(target)}" if target else "DVIA")
        elif interim and interim != (cruise_alt or 0):
            cmds.append(f"CM {self._alt_token(interim)}")
        elif cruise_alt:
            cmds.append(f"CM {self._alt_token(cruise_alt)}")

        # Speed vs Mach (SWIM gives e.g. "250", "S250", "M81", ".79").
        sp = self._speed_command(clr.get("speed"))
        if sp:
            cmds.append(sp)

        # Assigned heading (vector) — e.g. "020", "H020".
        hdg = self._heading_token(clr.get("heading"))
        if hdg:
            cmds.append(f"FH {hdg}")

        # Scratchpad from the 4th line — but vNAS re-applies it as an ERAM entry,
        # so skip deviation / "/"-delimited speed-alt formats (they trigger a bad
        # QS speed command, e.g. "DR/F").
        scratch = re.sub(r"\s+", " ", str(clr.get("fourthLine") or clr.get("text") or "")).strip()
        if not scratch or "/" in scratch or scratch.upper().startswith("DR"):
            scratch = None
        return cmds, scratch

    @staticmethod
    def _alt_token(alt_ft: int) -> str:
        """vNAS altitude token: flight levels as hundreds (FL240→'240'),
        low altitudes as feet ('5000')."""
        return str(alt_ft // 100) if alt_ft >= 18000 else str(alt_ft)

    @staticmethod
    def _speed_command(raw) -> Optional[str]:
        """vNAS speed clearances are: Sxxx (IAS), xxx+/- (IAS at/above/below),
        or Mxx+/- (Mach). Anything else (e.g. "DR/F" deviation) is NOT a speed —
        it's free 4th-line text and is ignored here."""
        import re
        s = str(raw or "").upper().strip()
        m = re.match(r"^([SM]?)(\d{2,4})[+-]?$", s)
        if not m:
            return None
        prefix, num = m.group(1), int(m.group(2))
        return f"MACH {num}" if prefix == "M" else f"SPD {num}"

    @staticmethod
    def _heading_token(raw) -> Optional[str]:
        import re
        digits = re.sub(r"\D", "", str(raw or ""))
        if not digits:
            return None
        n = int(digits) % 360
        if n == 0:
            n = 360  # vNAS rejects "000"; north is 360
        return f"{n:03d}"

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
