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


import functools


@functools.lru_cache(maxsize=1024)
def _airport_refpoint(icao: str):
    """(lat, lon) of an airport's FAA CIFP reference point — used to anchor a spawn
    on short airport-to-airport GA routes that have no resolvable enroute fix.
    Returns None if the airport isn't found (or the CIFP is unavailable)."""
    icao = (icao or "").strip().upper()
    if not (len(icao) == 4 and icao.isalpha()):
        return None
    try:
        from utils.data_pipeline.cifp_index import DEFAULT_CIFP_PATH
        prefix = f"SUSAP {icao}"
        with open(DEFAULT_CIFP_PATH, encoding="latin-1") as f:
            for ln in f:
                # Airport reference-point record: section 'P', subsection 'A'.
                if ln.startswith(prefix) and ln[12:13] == "A":
                    m = re.search(r"([NS])(\d{2})(\d{2})(\d{4})([EW])(\d{3})(\d{2})(\d{4})", ln)
                    if m:
                        la = int(m.group(2)) + int(m.group(3)) / 60 + int(m.group(4)) / 360000
                        lo = int(m.group(6)) + int(m.group(7)) / 60 + int(m.group(8)) / 360000
                        return (-la if m.group(1) == "S" else la,
                                -lo if m.group(5) == "W" else lo)
    except (OSError, ValueError):
        return None
    return None


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
        # The scenario's designated student position (the trainee seat the human
        # signs into). vNAS field "studentPositionId". First trainee seat.
        self.student_position_id = next(iter(atc.get("traineePositionIds") or []), None)
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

    def _build_atc_roster(self, position_ids) -> List[Dict]:
        """One auto-connecting ghost per position that is active in the capture —
        every sector that OWNS a track (position_ids) AND every sector that appears
        as a handoff partner (the editor's atcEntries, i.e. from/to of captured
        handoffs), plus the student's own seat. Staffing the handoff partners is
        what lets the trainee hand traffic OUT to the next sector (e.g. an ORD
        flight to a ZID sector): that receiving sector is online instead of
        "SECTOR NOT ACTIVE". The human takes the student seat over on sign-in."""
        roster: List[Dict] = []
        # atcEntries = active owners + handoff partners; position_ids = the owners
        # we actually assigned. Union them so downstream/upstream sectors are live.
        ids = list(self._atc_meta.keys()) + list(position_ids)
        if self.student_position_id:
            ids.append(self.student_position_id)  # always staff the trainee seat
        for pid in dict.fromkeys(p for p in ids if p):  # dedupe, ordered
            meta = self._atc_meta.get(pid) or {}
            roster.append({
                "id": _ulid(),
                "artccId": meta.get("artccId") or self.facility,
                "facilityId": meta.get("facilityId") or meta.get("artccId") or self.facility,
                "positionId": pid,
                "autoConnect": True,
                "autoTrackAirportIds": [],
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
            # Respect the editor's include flag so a saved capture can carry ALL
            # aircraft (with their edits) and still generate only the chosen ones.
            # Absent flag = included (raw captures have no flag).
            if entry.get("include") is False:
                continue
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

        # vNAS / data-admin requires dep & dest to be real ICAO airports — drop
        # FAA LIDs / fixes / DMEs to '' (they block the whole scenario save).
        # Coerced up front so the airport-anchor fallback below can use them.
        departure = _icao_airport(fp.get("departure"))
        destination = _icao_airport(fp.get("destination"))

        def _norm(r: str) -> str:
            # Strip SWIM per-token suffixes — "/TIME" (KPIT/0544) or "/speed-alt"
            # (FIX/N0450F350) — matching ONLY the alnum run after a '/', so the FAA
            # "./." route connector isn't consumed (the old "/\S+" ate to the end on
            # dot-compact routes). Then normalize '.'/'..' separators to spaces:
            # "KTPA./.CRG302047..RYCKI.Q69.RICCS" → "KTPA CRG302047 RYCKI Q69 RICCS".
            r = re.sub(r"/[A-Za-z0-9]+", "", r or "")
            return re.sub(r"[./]+", " ", r).strip()

        # Score each candidate route and keep the best. A route that actually REACHES
        # the destination wins — so the arrival's STAR + airport are present — over a
        # truncated filed route (SWIM's originalRoute is often clipped, e.g.
        # "KSAV..MARCL"); more resolvable fixes breaks the tie.
        best = None  # (score, norm, coords)
        for raw in (fp.get("originalRoute"), fp.get("route")):
            norm = _norm(raw)
            if not norm:
                continue
            coords = self.route_parser.get_route_waypoint_coordinates(
                self.route_parser.parse_route_string(norm))
            reaches = 1 if (destination and destination in norm.split()) else 0
            score = (reaches, len(coords))
            if best is None or score > best[0]:
                best = (score, norm, coords)
        if best is None:
            return None, "no_route"
        route_str, route_coords = best[1], best[2]

        if not route_coords:
            # No enroute fix resolved (short airport-to-airport GA routes). Anchor
            # the spawn off the departure/destination airport reference point so
            # the aircraft still loads instead of being dropped as "no_frd".
            for icao in (departure, destination):
                c = _airport_refpoint(icao)
                if c:
                    route_coords.append((icao, c[0], c[1]))
        if not route_coords:
            return None, "no_frd"

        frd = self.route_parser.generate_frd_position(lat, lon, route_coords)
        if not frd:
            return None, "no_frd"

        nav_path = self._downstream_route(route_coords, lat, lon, destination, tokens=route_str.split())

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

        # Live ATC replay. Each aircraft is initially owned by a GHOST (its
        # captured controlling sector). If the real-world traffic was handed INTO
        # the trainee's sector, the owning ghost flashes the handoff to the
        # student at the captured time via autoTrackConditions.handoffDelay.
        #
        # This is how working vNAS scenarios do it — NO preset HO commands (those
        # only work for in-house ERAM sectors by adaptation code, never by id and
        # never to a TRACON/neighbor). handoffDelay flashes to studentPositionId
        # and works even when the owner is an external or TRACON ghost. A TRACON
        # position can own an enroute track directly here (no ILL TRK), so the old
        # autoTrackAirportIds workaround is gone too.
        if self.atc_enabled:
            ent = entry.get("entry") or {}
            first = int(entry.get("firstSeenOffsetSec") or 0)
            spawn_key = (
                f"{(ent.get('controllingFacility') or '').upper()}/"
                f"{(ent.get('controllingSector') or '').upper()}"
            )
            handoffs = sorted(
                (h for h in (entry.get("handoffs") or []) if h.get("atOffsetSec") is not None),
                key=lambda h: int(h["atOffsetSec"]),
            )

            # When (if ever) does a trainee sector take ownership, and who hands
            # it over? student_handoff = (offsetSec, upstream_owner_key | None);
            # a None upstream means the trainee already owns it at spawn.
            student_handoff = None
            if spawn_key in self.trainee_owner_keys:
                student_handoff = (first, None)
            else:
                for h in handoffs:
                    to_key = (
                        f"{(h.get('toFacility') or '').upper()}/"
                        f"{(h.get('toSector') or '').upper()}"
                    )
                    if to_key in self.trainee_owner_keys:
                        student_handoff = (
                            int(h["atOffsetSec"]),
                            f"{(h.get('fromFacility') or '').upper()}/"
                            f"{(h.get('fromSector') or '').upper()}",
                        )
                        break

            goes_to_student = student_handoff is not None
            if goes_to_student and student_handoff[1] is None:
                # Trainee already owns it — hand the seat (and the track) to the
                # student at load.
                if self.student_position_id:
                    aircraft.auto_track_position_id = self.student_position_id
            elif goes_to_student:
                off, upstream_key = student_handoff
                owner = self._owner_position(upstream_key)
                if not owner:
                    # Direct upstream sector isn't mapped — use the first sector we
                    # DO staff that owns it before the trainee took it, so someone
                    # can flash the handoff; failing that, give it to the student.
                    owner = self._first_known_handoff_owner(handoffs, before=off)
                if owner:
                    aircraft.auto_track_position_id = owner
                    # Flash to the student at the real handoff time (≥1s so it
                    # actually flashes instead of spawning already owned).
                    aircraft.auto_track_handoff_delay = max(1, off - first)
                elif self.student_position_id:
                    aircraft.auto_track_position_id = self.student_position_id
            else:
                # Background traffic the trainee never works — owned by its (ghost)
                # sector the whole time for a realistic scope picture.
                owner = self._owner_position(spawn_key)
                if not owner:
                    # Untracked at spawn (unmapped sector, no fallback): pick it up
                    # at the first later handoff into a sector we staff, so it isn't
                    # left untracked. Owned from spawn by that position (vNAS has no
                    # "begin tracking at T" for a ghost, only handoffDelay-to-student).
                    owner = self._first_known_handoff_owner(handoffs)
                if owner:
                    aircraft.auto_track_position_id = owner

            # Re-issue captured controller instructions so the AI flies the real
            # profile. Only when AIRBORNE (a CM on the ground errors; ground speed
            # alone isn't enough — taxi/takeoff roll have speed but are on the
            # ground — so also require some altitude).
            #
            # For aircraft bound for the STUDENT we still issue the initial
            # ALTITUDE clearance (climb/descend to the captured cleared level): the
            # upstream ghost owns it until the handoff and flies it there, so the
            # trainee is handed an aircraft in its real state (e.g. climbing to its
            # filed FL320) instead of one frozen at the spawn altitude. Speed,
            # heading and later timed changes are left for the trainee — but the
            # 4th-line scratchpad IS set either way so the datablock reads current.
            airborne = ground_speed >= 40 and spawn_alt >= 1500
            on_arrival = bool((fp.get("star") or "").strip())
            if airborne:
                timed: List[tuple] = []  # (offsetSec, command)
                init_cmds, scratch = self._clearance_commands(
                    entry.get("clearances") or {}, cruise_alt, on_arrival=on_arrival,
                )
                if scratch:
                    aircraft.auto_track_scratchpad = scratch
                if goes_to_student:
                    for c in init_cmds:
                        if c.startswith(("CM", "DVIA")):
                            timed.append((0, c))
                else:
                    for c in init_cmds:
                        timed.append((0, c))
                    for ev in (entry.get("clearanceEvents") or []):
                        if ev.get("atOffsetSec") is None:
                            continue
                        c = self._event_command(ev)
                        if c:
                            timed.append((max(0, int(ev["atOffsetSec"]) - first), c))
                timed.sort(key=lambda x: x[0])
                if timed:
                    aircraft.preset_commands = [
                        c if t == 0 else f"WAIT {t} {c}" for t, c in timed
                    ]

        return aircraft, None

    def _owner_position(self, key: str) -> Optional[str]:
        """Resolve an ownership key ("FAC/SEC") to the vNAS position that should
        own the track. A STARS/TRACON position can only InitiateControl a track
        genuinely in its airspace (enroute-positioned tracks fail "ILL TRK"), so
        STARS owners are redirected to the enroute fallback (a center ghost).
        Returns None when nothing can own it (track spawns untracked)."""
        pid = self.owner_to_position.get(key)
        if pid and (self._atc_meta.get(pid) or {}).get("isStars"):
            return self.fallback_position  # avoid STARS InitiateControl / ILL TRK
        return pid or self.fallback_position

    def _first_known_handoff_owner(self, handoffs, before: Optional[int] = None) -> Optional[str]:
        """The first captured handoff whose TARGET sector resolves to a position we
        staff (optionally only handoffs before ``before`` seconds). Lets an aircraft
        that spawned untracked (unmapped sector, no fallback) get picked up once it
        crosses into a sector we do know, instead of floating untracked all run."""
        for h in handoffs:
            if before is not None and int(h["atOffsetSec"]) >= before:
                break
            cand = self._owner_position(
                f"{(h.get('toFacility') or '').upper()}/{(h.get('toSector') or '').upper()}")
            if cand:
                return cand
        return None

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
                          destination: str, tokens: Optional[List[str]] = None) -> str:
        """Build the navigationPath: the route AHEAD of the aircraft, ending at the
        destination.

        The "next fix" is the end of the route segment the aircraft is currently on,
        found by projecting its position onto each segment. When the raw route
        ``tokens`` are supplied we keep them (fixes AND airway/SID/STAR names, which
        vNAS expands) from that fix onward — otherwise an arrival would fly direct to
        the airport with its STAR dropped. Falls back to resolved fixes only when a
        token can't be matched."""
        n = len(route_coords)
        if n == 0:
            return destination or ""
        next_idx = self._next_fix_index(route_coords, lat, lon) if n >= 2 else n
        anchor = route_coords[next_idx][0] if next_idx < n else route_coords[-1][0]
        # Locate the anchor among the raw tokens. A procedure fix resolves without its
        # numeric suffix (JIIMS4 -> JIIMS, RAVNN9 -> RAVNN), so match by prefix too.
        ti = -1
        if tokens:
            if anchor in tokens:
                ti = tokens.index(anchor)
            else:
                for i, t in enumerate(tokens):
                    if t.startswith(anchor) or anchor.startswith(t):
                        ti = i
                        break
        if ti >= 0:
            # Keep the real route tail (procedures/airways included) from the next
            # fix onward; when we're past the last resolved fix, start just after it
            # so a trailing STAR (unresolved procedure name) is still flown.
            start = ti + (0 if next_idx < n else 1)
            tail = [t for t in tokens[start:] if t != destination]
            if destination:
                tail.append(destination)
            nav = " ".join(tail).strip()
            if nav:
                return nav
        names = [nm for nm, _, _ in route_coords[next_idx:]]
        if destination and (not names or names[-1] != destination):
            names.append(destination)
        return " ".join(names).strip() or destination or ""

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
