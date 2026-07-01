"""
Headless CLI bridge for the Electron frontend.

Usage:
    ssg_bridge(.exe) <config_json_path>

Reads a JSON configuration, dispatches to the matching scenario generator,
writes the vNAS scenario JSON, and prints one JSON status line to stdout:

    {"status": "ok", "filename": "...", "aircraft_count": N}
    {"status": "error", "message": "...", "trace": "..."}

A full run log is also written to `<app>/logs/ssg_<YYYYMMDD_HHMMSS>.log` and
tee'd to stderr so the Electron main process can surface errors verbatim.
"""
import json
import logging
import os
import re
import sys
import traceback
from datetime import datetime
from pathlib import Path


def _resource_root():
    """In PyInstaller onefile, _MEIPASS holds the extracted bundle dir."""
    mei = getattr(sys, '_MEIPASS', None)
    if mei:
        return Path(mei)
    return Path(__file__).resolve().parent


REPO_ROOT = _resource_root()
sys.path.insert(0, str(REPO_ROOT))


def _user_resources_root():
    """Return the user-editable resources directory next to the bundled exe,
    or None in dev mode.

    The electron-builder config ships our extraResources to
    `<install>/resources/`, and the PyInstaller bridge exe lives at
    `<install>/resources/bridge/ssg_bridge.exe`. Users drop updated airport
    files, AIRAC cycles, and a customized `config.json` into that sibling
    tree so they can customize without rebuilding the bridge.
    """
    if not getattr(sys, 'frozen', False):
        return None
    exe_dir = Path(sys.executable).resolve().parent
    # <install>/resources/bridge/ → <install>/resources/
    return exe_dir.parent


def _log_directory() -> Path:
    """Return (and create) the directory that holds per-run log files.

    - Packaged: `<install>/logs/` — a sibling of the `resources/` folder that
      holds `bridge/ssg_bridge.exe`. This is the end-user-visible location,
      next to the app's top-level `.exe`, matching the user's request of
      "whatever directory the exe is run from / logs /".
    - Dev: `<repo>/logs/` — matches the legacy PyQt `main_gui.py` behavior.
    """
    if getattr(sys, 'frozen', False):
        # sys.executable = <install>/resources/bridge/ssg_bridge.exe
        base = Path(sys.executable).resolve().parent.parent.parent
    else:
        base = Path(__file__).resolve().parent
    log_dir = base / 'logs'
    try:
        log_dir.mkdir(parents=True, exist_ok=True)
    except OSError:
        # Fall back to a user-writable temp location if the install dir is
        # read-only (e.g. machine-wide NSIS install without admin rights).
        import tempfile
        log_dir = Path(tempfile.gettempdir()) / 'ssg-logs'
        log_dir.mkdir(parents=True, exist_ok=True)
    return log_dir


_LOG_CONFIGURED = False


def _configure_logging() -> Path:
    """Install a file handler + stderr handler on the root logger.

    Returns the full path of the file the run will log to. Idempotent —
    calling it twice won't duplicate handlers.
    """
    global _LOG_CONFIGURED
    log_dir = _log_directory()
    log_path = log_dir / f"ssg_{datetime.now().strftime('%Y%m%d_%H%M%S')}.log"
    if _LOG_CONFIGURED:
        return log_path

    root = logging.getLogger()
    root.setLevel(logging.INFO)
    # Drop any pre-existing handlers so repeat invocations in the same
    # process (tests) don't stack.
    for h in list(root.handlers):
        root.removeHandler(h)

    fmt = logging.Formatter(
        '%(asctime)s %(levelname)s %(name)s: %(message)s',
        datefmt='%H:%M:%S',
    )

    file_h = logging.FileHandler(log_path, mode='w', encoding='utf-8')
    file_h.setLevel(logging.INFO)
    file_h.setFormatter(fmt)

    # stderr so the Electron IPC captures the same lines via proc.stderr;
    # stdout stays reserved for the single JSON status line.
    stream_h = logging.StreamHandler(sys.stderr)
    stream_h.setLevel(logging.INFO)
    stream_h.setFormatter(fmt)

    root.addHandler(file_h)
    root.addHandler(stream_h)
    _LOG_CONFIGURED = True
    return log_path


def resource_path(*parts):
    """Resolve a bundled-resource path (airport_data/..., config.json, ...).

    Lookup order:
      1. User-editable copy under `<install>/resources/` — so users can edit
         airport geojsons, drop a new FAACIFP18 cycle, or tweak config.json
         without rebuilding the bundled exe.
      2. PyInstaller-baked fallback at `_MEIPASS/` (or repo root in dev).
    """
    user = _user_resources_root()
    if user is not None:
        candidate = user.joinpath(*parts)
        if candidate.exists():
            return candidate
    return REPO_ROOT.joinpath(*parts)

from utils.api_client import FlightDataAPIClient  # noqa: E402
# NOTE: GeoJSONParser is imported lazily inside load_parsers() — it transitively
# pulls in FlightRadarAPI/selenium, which the live-replay capture/credentials
# paths don't need. Keeping it out of module import lets those actions run in a
# slimmer environment (and speeds bridge startup).
from generators.vnas_json_exporter import VNASJSONExporter  # noqa: E402
from utils.preset_command_processor import apply_preset_commands  # noqa: E402
from utils.data_pipeline import split_counts, load_cifp_index  # noqa: E402
from models.preset_command import PresetCommandRule  # noqa: E402


def parse_list(value, upper=False):
    """Accept either a list (preferred, from the new row-table UI) or a
    legacy comma-separated string and return a trimmed list of strings."""
    if value is None or value == '':
        return []
    if isinstance(value, list):
        out = [str(x).strip() for x in value if x is not None and str(x).strip()]
    else:
        out = [x.strip() for x in str(value).split(',') if x.strip()]
    return [x.upper() for x in out] if upper else out


def parse_runway_map(value):
    """Accept either:
      - list of {icao, runways: [..]} objects (preferred, new UI), or
      - list of {icao, runways: 'csv string'} objects, or
      - legacy string like 'KPHX:08,7R; KTUS:12'
    and return `{'KPHX': ['08','7R'], 'KTUS': ['12']}`."""
    out = {}
    if not value:
        return out
    # New object-list form
    if isinstance(value, list):
        for item in value:
            if not isinstance(item, dict):
                continue
            icao = (item.get('icao') or item.get('airport') or '').strip().upper()
            if not icao:
                continue
            runways_raw = item.get('runways')
            out[icao] = parse_list(runways_raw, upper=True)
        return out
    # Legacy string form
    for chunk in str(value).replace(';', ',,').split(',,'):
        chunk = chunk.strip()
        if not chunk or ':' not in chunk:
            continue
        code, runways = chunk.split(':', 1)
        out[code.strip().upper()] = parse_list(runways, upper=True)
    return out


def parse_arrival_procedure_map(value):
    """Pull per-airport STAR-prefix filters off the enroute arrival-airports
    row shape. Returns `({'KPHX': ['EAGUL', 'HYDRR']}, ['warning', ...])`.

    Invalid tokens (containing digits, or not alphabetic) are dropped with a
    warning string so the conclusion screen can surface them. Input is the
    same `arrivalAirports` list the UI already sends; each row may carry an
    `arrivals` field (either a list or a CSV string).
    """
    out = {}
    warnings = []
    if not value or not isinstance(value, list):
        return out, warnings
    for item in value:
        if not isinstance(item, dict):
            continue
        icao = (item.get('icao') or item.get('airport') or '').strip().upper()
        if not icao:
            continue
        raw = item.get('arrivals')
        tokens = parse_list(raw, upper=True)
        valid = []
        for tok in tokens:
            if re.match(r'^[A-Z]+$', tok):
                valid.append(tok)
            else:
                warnings.append(
                    f"{icao}: ignored invalid STAR prefix '{tok}' — use the "
                    f"5-letter base name without the trailing runway number "
                    f"(e.g. EAGUL, not EAGUL6)."
                )
        if valid:
            out[icao] = valid
    return out, warnings


def parse_waypoint_star_pairs(value):
    """Accept either:
      - list of {waypoint, star} objects (new UI), or
      - legacy string 'COLTR.COLTR4, CIM.BRRTO4'
    and return a list of 'WAYPOINT.STAR' strings that the existing scenario
    code understands.
    """
    if not value:
        return []
    if isinstance(value, list):
        out = []
        for item in value:
            if isinstance(item, str):
                item = item.strip()
                if item:
                    out.append(item)
                continue
            if not isinstance(item, dict):
                continue
            wp = (item.get('waypoint') or '').strip()
            star = (item.get('star') or '').strip()
            if wp and star:
                out.append(f"{wp}.{star}")
        return out
    return parse_list(value)


def parse_frd_rows(value):
    """Accept either:
      - list of {point, altitude, speed, initialRoute} objects, or
      - the legacy parallel-array shape (points/altitudes/speeds/initialRoutes
        as comma-separated strings).
    Returns a 4-tuple `(points_csv, alts_csv, speeds_csv, routes_csv)` matching
    the format the existing scenario paths already consume.
    """
    if not value:
        return (None, None, None, None)
    if isinstance(value, list):
        pts, alts, spds, rts = [], [], [], []
        for r in value:
            if not isinstance(r, dict):
                continue
            p = (r.get('point') or '').strip()
            if not p:
                continue
            pts.append(p)
            alts.append(str(r.get('altitude') or '').strip())
            spds.append(str(r.get('speed') or '').strip())
            rts.append((r.get('initialRoute') or '').strip())
        if not pts:
            return (None, None, None, None)
        return (
            ','.join(pts),
            ','.join(alts),
            ','.join(spds),
            ','.join(rts),
        )
    # Shouldn't happen with new UI, but be defensive:
    return (str(value) or None, None, None, None)


def difficulty_dict(d):
    if not d or not d.get('enabled'):
        return None
    return {
        'easy': int(d.get('easy', 0)),
        'medium': int(d.get('medium', 0)),
        'hard': int(d.get('hard', 0)),
    }


def load_parsers(airport):
    from parsers.geojson_parser import GeoJSONParser  # lazy: pulls FlightRadarAPI
    geojson_file = resource_path('airport_data', f'{airport}.geojson')
    if not geojson_file.exists():
        geojson_file = resource_path('airport_data', f'{airport.lstrip("K")}.geojson')
    geojson_parser = GeoJSONParser(str(geojson_file)) if geojson_file.exists() else None
    # CIFP indexes airports by ICAO (K-prefixed for the US). load_cifp_index
    # memoizes per process — each airport pays the parse cost once. Prefer
    # the user-editable FAACIFP18 next to the exe if present (AIRAC cycle
    # updates land there without rebuilding).
    cifp_parser = load_cifp_index(airport, str(resource_path('airport_data', 'FAACIFP18')))
    return geojson_parser, cifp_parser


from utils.data_pipeline import to_icao  # noqa: E402,F401


# Populated by `dispatch()` for enroute runs and read by `main()` so we
# can include per-type generation stats in the JSON response.
_LAST_GENERATION_STATS = None  # Optional[dict]
_LAST_ATC_ROSTER = None  # Optional[list] — pseudo-ATC roster for live_replay
_LAST_STUDENT_POS = None  # Optional[str] — studentPositionId for live_replay


def dispatch(cfg):
    # --- Live Replay (SWIM sector capture) ---------------------------------
    # Handled first: it reads a capture file rather than the live flight API,
    # and has no departure airport (the identifier is the ARTCC facility).
    if cfg.get('scenarioType') == 'live_replay':
        from scenarios.live_replay import LiveReplayScenario
        capture_file = cfg.get('captureFile')
        if not capture_file:
            raise ValueError("live_replay scenario requires a 'captureFile' path")
        if not Path(capture_file).is_file():
            raise ValueError(
                f"Capture file not found: {Path(capture_file).name}. The capture may "
                "not have finished saving (e.g. it was interrupted, or SSG was closed "
                "mid-capture). Re-run the capture, then generate again."
            )
        sc = LiveReplayScenario.from_file(
            capture_file,
            hold_initial_altitude=bool(cfg.get('holdInitialAltitude', False)),
        )
        aircraft = sc.generate()
        globals()['_LAST_GENERATION_STATS'] = getattr(sc, 'generation_stats', None)
        # Pseudo-ATC roster: controllers that staff the positions aircraft are
        # auto-tracked to (so tracks are owned at load + handoffs flash).
        globals()['_LAST_ATC_ROSTER'] = getattr(sc, 'atc_roster', None) or []
        globals()['_LAST_STUDENT_POS'] = getattr(sc, 'student_position_id', None)
        # Return the ARTCC facility as the identifier so the exporter uses the
        # enroute (artccId) path rather than an airport code.
        return aircraft, sc.facility

    airport = cfg['departureAirport']
    scenario_type = cfg['scenarioType']
    api = FlightDataAPIClient()

    active_runways = parse_list(cfg.get('activeRunways', ''), upper=True)
    separation = int(cfg.get('separationRange', 0) or 0)

    # Coerce the string payload to the SpawnDelayMode enum. Without this the
    # `==` checks in `BaseScenario.apply_spawn_delays` all return False, so
    # every aircraft.spawn_delay stays None and the vNAS converter omits the
    # `spawnDelay` field entirely.
    from models.spawn_delay_mode import SpawnDelayMode  # local import: avoid widening the top-level surface
    raw_mode = cfg.get('spawnDelayMode', 'none')
    if not cfg.get('spawnDelayEnabled'):
        raw_mode = 'none'
    try:
        spawn_mode = SpawnDelayMode(raw_mode)
    except ValueError:
        spawn_mode = SpawnDelayMode.NONE

    delay_value = cfg.get('incrementalDelayValue') or None
    total_minutes = int(cfg.get('totalSessionMinutes', 30) or 30)
    dep_diff = difficulty_dict(cfg.get('departureDifficulty'))
    arr_diff = difficulty_dict(cfg.get('arrivalDifficulty'))
    enr_diff = difficulty_dict(cfg.get('enrouteDifficulty'))
    arrival_mode = cfg.get('arrivalMode', 'star')
    arrival_waypoints = parse_waypoint_star_pairs(cfg.get('arrivalWaypoints', ''))
    enable_cifp_sids = bool(cfg.get('enableCifpSids', True))
    manual_sids_raw = cfg.get('manualSids')
    manual_sids = parse_list(manual_sids_raw, upper=True) if manual_sids_raw else None
    use_cifp_speeds = bool(cfg.get('useCifpSpeeds', True))
    num_vfr = int(cfg.get('numVfr', 0) or 0) if cfg.get('enableVfr') else 0
    vfr_raw = cfg.get('vfrSpawnLocations')
    vfr_locs = parse_list(vfr_raw) if vfr_raw else None
    # FRD: prefer the new structured `frd: [{point,altitude,speed,initialRoute}]`
    # form; fall back to the legacy parallel-array shape if the new field is absent.
    if cfg.get('frd'):
        frd = parse_frd_rows(cfg.get('frd'))
    else:
        frd = (
            cfg.get('frdPoints') or None,
            cfg.get('frdAltitudes') or None,
            cfg.get('frdSpeeds') or None,
            cfg.get('frdInitialRoutes') or None,
        )

    num_dep = int(cfg.get('numDepartures', 0) or 0)
    num_arr = int(cfg.get('numArrivals', 0) or 0)
    num_enr = int(cfg.get('numEnroute', 0) or 0)
    num_ovf = int(cfg.get('numOverflight', 0) or 0)

    wake_bias_raw = cfg.get('wakeBias') or {}
    if cfg.get('wakeBiasEnabled') and wake_bias_raw:
        wake_weights = {k.upper(): float(wake_bias_raw.get(k, 0) or 0) for k in ('L', 'M', 'H')}
        # Proportional renormalization so client drift (sum != 100) doesn't
        # silently under/over-weight the mix. split_counts already handles
        # sum==0 by falling back to a flat distribution.
        wake_total = sum(wake_weights.values())
        if wake_total and wake_total != 100:
            scale = 100.0 / wake_total
            wake_weights = {k: v * scale for k, v in wake_weights.items()}
    else:
        wake_weights = {'L': 1.0, 'M': 1.0, 'H': 1.0}
    dep_wake_counts = split_counts(num_dep, wake_weights)
    arr_wake_counts = split_counts(num_arr, wake_weights)

    # Server-side validation for the subset of rules the renderer skips.
    if (scenario_type in ('tracon_arrivals', 'tracon_mixed')
            and arrival_mode == 'star'
            and not arrival_waypoints):
        raise ValueError(
            "STAR arrival mode requires at least one 'WAYPOINT.STAR' pair "
            "(e.g. 'COLTR.COLTR4'). Set arrivalWaypoints or switch to FRD mode."
        )

    # --- Enroute -----------------------------------------------------------
    if scenario_type == 'enroute':
        from scenarios.artcc_enroute import ArtccEnrouteScenario

        # New config unifies airports and runways into a single
        # [{icao, runways}] list per direction. Legacy configs kept them
        # split (`arrivalAirports` + `arrivalAirportRunways`), so fall back.
        arr_items = cfg.get('arrivalAirports')
        dep_items = cfg.get('departureAirports')

        def _extract_icaos(items):
            if isinstance(items, list):
                return [
                    (i.get('icao') or i.get('airport') or '').strip().upper()
                    for i in items if isinstance(i, dict) and (i.get('icao') or i.get('airport'))
                ]
            return parse_list(items, upper=True)

        arr_airports = _extract_icaos(arr_items)
        dep_airports = _extract_icaos(dep_items)
        arr_rwys = parse_runway_map(
            arr_items if isinstance(arr_items, list) else cfg.get('arrivalAirportRunways', '')
        )
        dep_rwys = parse_runway_map(
            dep_items if isinstance(dep_items, list) else cfg.get('departureAirportRunways', '')
        )

        def _extract_counts(items):
            """{ICAO: int} from per-airport `count` field on the new UI shape."""
            if not isinstance(items, list):
                return {}
            out = {}
            for i in items:
                if not isinstance(i, dict):
                    continue
                icao = (i.get('icao') or i.get('airport') or '').strip().upper()
                if not icao:
                    continue
                raw = i.get('count')
                try:
                    out[icao] = max(0, int(raw)) if raw not in (None, '') else 0
                except (TypeError, ValueError):
                    out[icao] = 0
            return out

        arr_counts = _extract_counts(arr_items)
        dep_counts = _extract_counts(dep_items)

        def _extract_bands(items):
            """{ICAO: (min_nm, max_nm)} from per-airport spawnMinNm/spawnMaxNm."""
            if not isinstance(items, list):
                return {}
            out = {}
            for i in items:
                if not isinstance(i, dict):
                    continue
                icao = (i.get('icao') or i.get('airport') or '').strip().upper()
                if not icao:
                    continue
                lo = i.get('spawnMinNm')
                hi = i.get('spawnMaxNm')
                try:
                    lo_f = float(lo) if lo not in (None, '') else None
                    hi_f = float(hi) if hi not in (None, '') else None
                except (TypeError, ValueError):
                    continue
                if lo_f is None or hi_f is None or hi_f < lo_f:
                    continue
                out[icao] = (lo_f, hi_f)
            return out

        per_airport_arr_bands = _extract_bands(arr_items)

        # STAR prefix filter on the arrival flight pool (e.g., only EAGUL
        # arrivals to KPHX). Invalid tokens are dropped with warnings that
        # get surfaced on the conclusion screen alongside shortfall.
        per_airport_arr_procs, arr_proc_warnings = parse_arrival_procedure_map(arr_items)

        def _parse_band(val, default):
            if isinstance(val, dict):
                lo = val.get('minDistanceNm') or val.get('min')
                hi = val.get('maxDistanceNm') or val.get('max')
                try:
                    lo_f = float(lo); hi_f = float(hi)
                    if hi_f >= lo_f:
                        return (lo_f, hi_f)
                except (TypeError, ValueError):
                    pass
            return default

        arr_band = _parse_band(cfg.get('arrivalSpawn'), (80.0, 140.0))
        ovf_band = _parse_band(cfg.get('overflightSpawn'), (10.0, 25.0))

        # Optional custom scenario boundary. When enabled and ≥4 waypoints
        # are supplied, the scenario replaces the ARTCC polygon with a
        # user-defined polygon built from these waypoints. The UI validates
        # the 4-waypoint minimum; the scenario also guards against it.
        cb = cfg.get('customBoundary') or {}
        custom_boundary_waypoints = (
            [w for w in (cb.get('waypoints') or []) if isinstance(w, str) and w.strip()]
            if cb.get('enabled') else None
        )

        # When the per-airport counts are populated, they authoritatively
        # define the enroute arrivals/departures total. Renderer already
        # does this math; this makes direct-bridge invocations robust too.
        if sum(arr_counts.values()) > 0:
            num_arr = sum(arr_counts.values())
        if sum(dep_counts.values()) > 0:
            num_dep = sum(dep_counts.values())
        sc = ArtccEnrouteScenario(
            airport, api, cfg,
            geojson_parsers={}, cifp_parsers={},
        )
        aircraft = sc.generate(
            num_enroute=num_enr, num_arrivals=num_arr, num_departures=num_dep,
            num_overflight=num_ovf,
            arrival_airports=arr_airports, departure_airports=dep_airports,
            arrival_airport_runways=arr_rwys, departure_airport_runways=dep_rwys,
            per_airport_arrival_counts=arr_counts,
            per_airport_departure_counts=dep_counts,
            arrival_spawn_band=arr_band,
            overflight_spawn_band=ovf_band,
            per_airport_arrival_bands=per_airport_arr_bands,
            per_airport_arrival_procedures=per_airport_arr_procs,
            config_warnings=arr_proc_warnings,
            difficulty_config_enroute=enr_diff,
            difficulty_config_arrivals=arr_diff,
            difficulty_config_departures=dep_diff,
            spawn_delay_mode=spawn_mode, delay_value=delay_value,
            total_session_minutes=total_minutes,
            cached_departures_pool=None, cached_arrivals_pool=None,
            cached_transient_pool=None,
            custom_boundary_waypoints=custom_boundary_waypoints,
        )
        # Expose generation stats on the module so `main()` can include
        # them in the bridge JSON response (enroute only).
        global _LAST_GENERATION_STATS
        _LAST_GENERATION_STATS = getattr(sc, 'generation_stats', None)
        return aircraft, airport

    # --- Airport-based -----------------------------------------------------
    geojson_parser, cifp_parser = load_parsers(airport)
    # Scenarios issue their own targeted API calls via
    # BaseScenario._prepare_departure_flight_pool / _prepare_arrival_flight_pool;
    # no pre-populated flight data is threaded through.

    ga_config = cfg.get('ga') or {}

    def _attach_budgets(s):
        s.set_wake_budgets(dep_wake_counts, arr_wake_counts)
        s.set_ga_config(ga_config)
        return s

    if scenario_type == 'ground_departures':
        from scenarios.ground_departures import GroundDeparturesScenario
        sc = _attach_budgets(GroundDeparturesScenario(airport, geojson_parser, cifp_parser, api))
        aircraft = sc.generate(
            num_dep, spawn_mode, delay_value, total_minutes, None,
            dep_diff, active_runways, enable_cifp_sids, manual_sids,
        )

    elif scenario_type == 'ground_mixed':
        from scenarios.ground_mixed import GroundMixedScenario
        sc = _attach_budgets(GroundMixedScenario(airport, geojson_parser, cifp_parser, api))
        aircraft = sc.generate(
            num_dep, num_arr, active_runways, separation,
            spawn_mode, delay_value, total_minutes, None, None,
            enable_cifp_sids, manual_sids,
            dep_diff, arr_diff,
        )

    elif scenario_type == 'tower_mixed':
        from scenarios.tower_mixed import TowerMixedScenario
        sc = _attach_budgets(TowerMixedScenario(airport, geojson_parser, cifp_parser, api))
        aircraft = sc.generate(
            num_dep, num_arr, active_runways, separation,
            spawn_mode, delay_value, total_minutes, None, None,
            enable_cifp_sids, manual_sids,
            num_vfr, vfr_locs,
            dep_diff, arr_diff,
        )

    elif scenario_type == 'tracon_arrivals':
        from scenarios.tracon_arrivals import TraconArrivalsScenario
        sc = _attach_budgets(TraconArrivalsScenario(airport, geojson_parser, cifp_parser, api))
        aircraft = sc.generate(
            num_arr, arrival_waypoints, None, spawn_mode, delay_value, total_minutes,
            None, arr_diff, active_runways, use_cifp_speeds,
            arrival_mode=arrival_mode,
            frd_points=frd[0], frd_altitudes=frd[1],
            frd_speeds=frd[2], frd_initial_routes=frd[3],
        )

    elif scenario_type == 'tracon_mixed':
        from scenarios.tracon_mixed import TraconMixedScenario
        sc = _attach_budgets(TraconMixedScenario(airport, geojson_parser, cifp_parser, api))
        aircraft = sc.generate(
            num_dep, num_arr, arrival_waypoints, None, spawn_mode,
            delay_value, total_minutes, None,
            None, active_runways, enable_cifp_sids, manual_sids,
            use_cifp_speeds, num_vfr, vfr_locs,
            dep_diff, arr_diff,
            arrival_mode=arrival_mode,
            frd_points=frd[0], frd_altitudes=frd[1],
            frd_speeds=frd[2], frd_initial_routes=frd[3],
        )

    else:
        raise ValueError(f'Unknown scenario type: {scenario_type}')

    return aircraft, None


def _action_save_credentials(cfg):
    """Persist SFDPS credentials supplied by the GUI."""
    from utils.live_capture import CredentialStore, SwimCredentials
    store = CredentialStore()
    creds = SwimCredentials(
        user=cfg.get('user', '') or '',
        password=cfg.get('password', '') or '',
        queue=cfg.get('queue', '') or '',
        host=cfg.get('host') or '',
        vpn=cfg.get('vpn') or '',
    )
    # Blank password on save = "keep the existing one" (the UI never reloads the
    # stored secret, so editing other fields must not wipe it).
    if not creds.password:
        creds.password = store.load().password
    store.save(creds)
    return {'status': 'ok'}


def _action_load_credentials(cfg):
    """Return stored SFDPS credentials (password presence only, never value)."""
    from utils.live_capture import CredentialStore
    c = CredentialStore().load()
    return {
        'status': 'ok',
        'user': c.user, 'queue': c.queue, 'host': c.host, 'vpn': c.vpn,
        'hasPassword': bool(c.password),
        'isComplete': c.is_complete(),
    }


def _resolve_sector_kml(cfg):
    """Path to the sector KML — caller-provided, else the bundled AllSectors.kml."""
    if cfg.get('kml'):
        return cfg['kml']
    p = resource_path('airport_data', 'AllSectors.kml')
    return str(p) if p.exists() else None


def _action_capture(cfg, logger):
    """Run a live capture (whole facility by default) and write a capture file."""
    import time
    from utils.live_capture import CredentialStore, SwimServerManager
    from utils.live_capture.swim_ws import SwimCaptureClient

    facility = (cfg.get('facility') or '').strip().upper()
    sector = (cfg.get('sector') or '').strip()  # '' / 'ALL' => whole facility; else comma list
    if not facility:
        return {'status': 'error', 'message': 'capture requires a facility'}
    facility_wide = (sector == '' or sector.upper() == 'ALL')
    sector_list = [] if facility_wide else [s.strip() for s in sector.split(',') if s.strip()]

    window = int(cfg.get('windowSeconds') or 1800)
    warmup = int(cfg.get('warmupSeconds') or 0)
    host = cfg.get('host') or 'localhost'
    port = int(cfg.get('port') or 5001)

    # Boundary geometry (fallback for flights with no ownership). Defaults to
    # the bundled AllSectors.kml. Facility-wide uses every sector polygon.
    boundary = None
    boundary_name = None
    kml = _resolve_sector_kml(cfg)
    if kml:
        from parsers.kml_parser import parse_sectors_kml
        index = parse_sectors_kml(kml)
        boundary_name = Path(kml).name
        if facility_wide:
            boundary = index.sectors_for(facility) or None
        else:
            boundary = [b for b in (index.get(facility, s) for s in sector_list) if b] or None
            if boundary is None:
                logger.warning(f"Sectors {sector_list} not in KML for {facility}; ownership-only membership")

    # "End now" support: the GUI creates `stopFile` on disk; a watcher flips the
    # stop_event so the capture loop (and warmup) exits early but still writes
    # everything recorded so far (so the partial capture is still generatable).
    import threading
    stop_event = None
    stop_file = cfg.get('stopFile')
    if stop_file:
        stop_event = threading.Event()
        sf = Path(stop_file)

        def _watch():
            while not stop_event.is_set():
                if sf.exists():
                    logger.info("Stop requested (end now)")
                    stop_event.set()
                    break
                time.sleep(0.5)

        threading.Thread(target=_watch, daemon=True).start()

    # Attach to the warm SwimServer (started by 'connect'). If none is running,
    # start one detached so it stays warm; never stop it here — the user
    # disconnects explicitly.
    if cfg.get('startServer', True):
        creds = CredentialStore().load()
        manager = SwimServerManager(creds, host=host, port=port)
        manager.start(reuse_existing=True, detached=True)
        if not manager.wait_until_ready(timeout=90):
            return {'status': 'error', 'message': 'SwimServer not reachable — click Connect first.'}
        if warmup > 0:
            logger.info(f"Warming up {warmup}s before capture window...")
            for _ in range(warmup):
                if stop_event is not None and stop_event.is_set():
                    break
                time.sleep(1)

    client = SwimCaptureClient(
        facility, sector or None, host=host, port=port,
        boundary=boundary, boundary_kml_name=boundary_name,
        vicinity_nm=float(cfg.get('vicinityNm') or 0),
    )

    def progress(elapsed, total, n, sectors):
        # Parsed by the Electron capture IPC for the progress display.
        logger.info(f"Capture progress: {int(elapsed)}/{int(total)}s recorded={n} sectors={sectors}")

    # Compute the output path up front and autosave to it during capture, so a
    # crash/disconnect/early-stop never loses the data — it's always on disk.
    out_dir = Path(cfg.get('outputDir') or (Path.home() / 'SSG' / 'captures'))
    out_dir.mkdir(parents=True, exist_ok=True)
    short = facility[1:] if facility.startswith('K') and len(facility) == 4 else facility
    sec_label = 'ALL' if facility_wide else '-'.join(sector_list)
    fname = out_dir / f"{short}_{sec_label}_{datetime.now().strftime('%d%H%M')}.capture.json"

    try:
        result = client.capture(window, progress_callback=progress, stop_event=stop_event,
                                autosave_path=str(fname))
    finally:
        if stop_file:
            try:
                Path(stop_file).unlink()
            except OSError:
                pass

    result.write(fname)
    return {
        'status': 'ok',
        'captureFile': str(fname),
        'recorded': len(result.aircraft),
        'diagnostics': result.diagnostics,
    }


def _action_route_sectors(cfg, logger):
    """For each captured aircraft, compute which KML sectors its filed route
    passes through (lateral + altitude band). Powers the editor's
    'select by sector (flight-plan path)' tool. Returns {gufi: [sectorId,...]}."""
    from parsers.kml_parser import parse_sectors_kml
    from utils.route_positioning import RouteParser
    facility = (cfg.get('facility') or '').strip().upper()
    cap_path = cfg.get('captureFile')
    if not facility or not cap_path:
        return {'status': 'error', 'message': 'facility and captureFile required'}
    try:
        cap = json.loads(Path(cap_path).read_text('utf-8'))
    except Exception as e:  # noqa: BLE001
        return {'status': 'error', 'message': f'cannot read capture: {e}'}
    kml = _resolve_sector_kml(cfg)
    if not kml:
        return {'status': 'error', 'message': 'no sector KML available'}
    index = parse_sectors_kml(kml)
    sectors = index.sectors_for(facility)
    rp = RouteParser()

    out = {}
    for a in cap.get('aircraft', []):
        fp = a.get('flightplan') or {}
        route = fp.get('route') or ''
        alt = fp.get('cruiseAltitudeFt')
        coords = rp.get_route_waypoint_coordinates(rp.parse_route_string(route))
        hit = set()
        for (_nm, lat, lon) in coords:
            for b in sectors:
                if b.sector in hit:
                    continue
                if b.contains(lat, lon, alt):
                    hit.add(b.sector)
        out[a.get('gufi')] = sorted(hit)
    return {'status': 'ok', 'routeSectors': out}


def _fetch_artcc_raw(artcc_id, logger, cache_ttl=86400):
    """Fetch + disk-cache an ARTCC's full config (the payloads are multi-MB, so
    cache for a day). Returns the parsed JSON or None."""
    import time as _t
    import requests
    cache_dir = Path(os.environ.get('LOCALAPPDATA') or os.path.expanduser('~')) / 'SSG' / 'poscache'
    cache_dir.mkdir(parents=True, exist_ok=True)
    cf = cache_dir / f"{artcc_id}.json"
    if cf.exists() and (_t.time() - cf.stat().st_mtime) < cache_ttl:
        try:
            return json.loads(cf.read_text('utf-8'))
        except Exception:  # noqa: BLE001
            pass
    # Retry: under concurrent load the data-api can transiently fail/rate-limit,
    # which silently dropped neighbor ARTCCs (so the editor showed ZDC only).
    url = f"https://data-api.vnas.vatsim.net/api/artccs/{artcc_id}"
    last_err = None
    for attempt in range(3):
        try:
            r = requests.get(url, timeout=30)
            r.raise_for_status()
            data = r.json()
            # Atomic write (temp + replace) so a concurrent bridge process can
            # never read a half-written / concatenated cache ("Extra data").
            tmp = cf.with_suffix(f'.{os.getpid()}.tmp')
            tmp.write_text(json.dumps(data), encoding='utf-8')
            os.replace(tmp, cf)
            return data
        except Exception as e:  # noqa: BLE001
            last_err = e
            _t.sleep(0.4 * (attempt + 1))
    # Last resort: serve a stale cache rather than dropping the facility.
    if cf.exists():
        try:
            logger.warning(f"fetch ARTCC {artcc_id} failed ({last_err}); using stale cache")
            return json.loads(cf.read_text('utf-8'))
        except Exception:  # noqa: BLE001
            pass
    logger.warning(f"fetch ARTCC {artcc_id} failed after retries: {last_err}")
    return None


def _extract_positions(data, artcc_id, is_neighbor):
    """Flatten an ARTCC's positions (incl. child TRACONs/towers), each tagged
    with its facility name + type for grouping in the editor."""
    out = []

    def walk(fac):
        if not isinstance(fac, dict):
            return
        for p in (fac.get('positions') or []):
            out.append({
                'id': p.get('id'),
                'sectorId': ((p.get('eramConfiguration') or {}) or {}).get('sectorId'),
                'name': p.get('name'),
                'callsign': p.get('callsign'),
                'frequency': p.get('frequency'),
                'facility': fac.get('name'),
                'facilityId': fac.get('id'),
                'facilityType': fac.get('type'),
                'artcc': artcc_id,
                'isNeighbor': is_neighbor,
            })
        for c in (fac.get('childFacilities') or []):
            walk(c)

    walk((data or {}).get('facility', {}))
    return out


def _extract_facility_airports(data):
    """Map each facility id -> the 3-letter airport ids it CONTROLS (its own id if
    it's an ATCT/AtctTracon/AtctRapcon, plus its direct ATCT children). A TRACON's
    autoTrackAirportIds must only contain airports it controls, else vNAS rejects
    it ("Airport is not controlled by your facility")."""
    out = {}

    def walk(fac):
        if not isinstance(fac, dict):
            return
        fid = fac.get('id')
        ftype = fac.get('type') or ''
        ids = set()
        if ftype in ('Atct', 'AtctTracon', 'AtctRapcon') and fid:
            ids.add(fid)
        for c in (fac.get('childFacilities') or []):
            if (c.get('type') or '') == 'Atct' and c.get('id'):
                ids.add(c['id'])
        if fid and ids:
            out[fid] = sorted(ids)
        for c in (fac.get('childFacilities') or []):
            walk(c)

    walk((data or {}).get('facility', {}))
    return out


def _action_get_positions(cfg, logger):
    """Pull vNAS positions for the facility, its child TRACONs/towers, AND its
    neighboring ARTCCs (so the editor can map TRACON + inter-facility handoff
    positions, not just enroute). Each position is tagged with its facility for
    grouped selection. Neighbor payloads are disk-cached."""
    import concurrent.futures
    facility = (cfg.get('facility') or '').strip().upper()
    logger.info(f"get_positions: facility={facility!r}")
    if not facility:
        return {'status': 'error', 'message': 'facility required'}

    target = _fetch_artcc_raw(facility, logger, cache_ttl=0)  # always fresh for the target
    if target is None:
        return {'status': 'error', 'message': f'could not fetch {facility} from vNAS'}

    positions = _extract_positions(target, facility, is_neighbor=False)
    facility_airports = _extract_facility_airports(target)

    # Neighboring ARTCCs (Z*) — fetch their positions too (cached, concurrent).
    neighbors = [n for n in (target.get('facility', {}).get('neighboringFacilityIds') or [])
                 if isinstance(n, str) and n.startswith('Z') and n != facility]
    if neighbors and cfg.get('includeNeighbors', True):
        with concurrent.futures.ThreadPoolExecutor(max_workers=6) as ex:
            results = ex.map(lambda z: (z, _fetch_artcc_raw(z, logger)), neighbors)
            for z, data in results:
                if data is not None:
                    positions.extend(_extract_positions(data, z, is_neighbor=True))
                    facility_airports.update(_extract_facility_airports(data))

    with_sec = sum(1 for p in positions if p.get('sectorId'))
    logger.info(f"get_positions: {facility} (+{len(neighbors)} neighbors) -> "
                f"{len(positions)} positions ({with_sec} with sectorId)")
    return {'status': 'ok', 'facility': facility, 'positions': positions,
            'neighbors': neighbors, 'facilityAirports': facility_airports}


def _action_get_sectors(cfg, logger):
    """Return the polygon geometry for a facility's sectors (from the bundled
    KML), for the in-app live scope. No SwimServer needed."""
    from parsers.kml_parser import parse_sectors_kml
    facility = (cfg.get('facility') or '').strip().upper()
    if not facility:
        return {'status': 'error', 'message': 'facility required'}
    kml = _resolve_sector_kml(cfg)
    if not kml:
        return {'status': 'error', 'message': 'no sector KML available'}
    index = parse_sectors_kml(kml)
    out = []
    for b in index.sectors_for(facility):
        rings = [[[round(lon, 5), round(lat, 5)] for (lon, lat) in v.ring] for v in b.volumes]
        out.append({
            'sector': b.sector,
            'designator': b.designator,
            'stratum': b.stratum,
            'floor': b.volumes[0].floor_ft if b.volumes else None,
            'ceiling': b.volumes[0].ceiling_ft if b.volumes else None,
            'rings': rings,
        })
    return {'status': 'ok', 'facility': facility, 'sectors': out}


def _action_connect(cfg, logger):
    """Start SwimServer with stored creds and KEEP IT WARM (detached). Confirms
    the SWIM feed authenticates and data is flowing, then leaves the server
    running so captures attach to a warm flight map. Stop it via 'disconnect'."""
    import time
    import requests
    from utils.live_capture import CredentialStore, SwimServerManager

    creds = CredentialStore().load()
    if not creds.is_complete():
        return {'status': 'error', 'message': 'SWIM credentials are incomplete (set user, password, queue).'}

    host = cfg.get('host') or 'localhost'
    port = int(cfg.get('port') or 5001)
    manager = SwimServerManager(creds, host=host, port=port)
    manager.start(reuse_existing=True, detached=True)  # stays warm; not stopped
    if not manager.wait_until_ready(timeout=60):
        return {'status': 'error', 'message': 'SwimServer did not start (check that the SwimServer build is present).'}

    base = f"http://{host}:{port}"
    connected = False
    flights = 0
    total = 0
    deadline = time.monotonic() + 40
    while time.monotonic() < deadline:
        try:
            s = requests.get(f"{base}/api/stats", timeout=5).json()
            connected = bool(s.get('connected'))
            flights = int(s.get('flights') or 0)
            total = int(s.get('total') or 0)
            if connected and total > 0:
                break
        except Exception:  # noqa: BLE001
            pass
        time.sleep(2)

    if connected and total > 0:
        return {'status': 'ok', 'connected': True, 'flights': flights, 'messages': total,
                'message': f'Connected — warming up. {flights} flights, {total} messages.'}
    if connected:
        return {'status': 'ok', 'connected': True, 'flights': flights, 'messages': total,
                'message': 'Connected — waiting for data (check the SFDPS queue if it stays at 0).'}
    return {'status': 'error', 'connected': False,
            'message': 'Could not authenticate to SWIM — check username/password/queue.'}


def _action_disconnect(cfg, logger):
    """Stop the warm SwimServer started by 'connect'."""
    from utils.live_capture import stop_persistent
    return {'status': 'ok', 'stopped': stop_persistent()}


def main(config_path):
    log_path = _configure_logging()
    logger = logging.getLogger('ssg_bridge')
    logger.info(f"SSG bridge start; log file: {log_path}")
    logger.info(f"Config: {config_path}")

    cfg = json.loads(Path(config_path).read_text('utf-8'))

    # Non-generation actions for the live-replay capture feature. These reuse
    # the same single bridge exe (no separate Python interpreter at runtime).
    action = cfg.get('action', 'generate')
    if action == 'save_credentials':
        print(json.dumps(_action_save_credentials(cfg)))
        return
    if action == 'load_credentials':
        print(json.dumps(_action_load_credentials(cfg)))
        return
    if action == 'capture':
        print(json.dumps(_action_capture(cfg, logger)))
        return
    if action in ('connect', 'test_credentials'):
        print(json.dumps(_action_connect(cfg, logger)))
        return
    if action == 'disconnect':
        print(json.dumps(_action_disconnect(cfg, logger)))
        return
    if action == 'get_sectors':
        print(json.dumps(_action_get_sectors(cfg, logger)))
        return
    if action == 'get_positions':
        print(json.dumps(_action_get_positions(cfg, logger)))
        return
    if action == 'route_sectors':
        print(json.dumps(_action_route_sectors(cfg, logger)))
        return

    aircraft, artcc_id = dispatch(cfg)

    preset_rules = [
        PresetCommandRule(
            group_type=r['groupType'],
            group_value=r.get('groupValue') or None,
            command_template=r['commandTemplate'],
        )
        for r in cfg.get('presetCommands', [])
        if r.get('commandTemplate')
    ]
    if preset_rules:
        apply_preset_commands(aircraft, preset_rules)

    out_dir = Path(cfg.get('outputDir') or (Path.home() / 'SSG' / 'scenarios'))
    out_dir.mkdir(parents=True, exist_ok=True)

    filename = VNASJSONExporter.export(
        aircraft,
        cfg.get('departureAirport'),
        artcc_id,
        cfg.get('scenarioName') or cfg['scenarioType'],
        str(out_dir),
        atc=_LAST_ATC_ROSTER,
        student_position_id=_LAST_STUDENT_POS,
    )
    logger.info(f"Generated {len(aircraft)} aircraft -> {filename}")
    response = {
        'status': 'ok',
        'filename': str(filename),
        'aircraft_count': len(aircraft),
        'logFile': str(log_path),
    }
    if _LAST_GENERATION_STATS:
        response['generation_stats'] = _LAST_GENERATION_STATS
    print(json.dumps(response))


if __name__ == '__main__':
    log_path_for_error = None
    try:
        # Initialize logging as early as possible so startup errors get captured.
        log_path_for_error = _configure_logging()
        if len(sys.argv) < 2:
            raise SystemExit('usage: ssg_bridge <config.json>')
        main(sys.argv[1])
    except Exception as exc:  # noqa: BLE001
        logging.getLogger('ssg_bridge').exception("Unhandled bridge error")
        print(json.dumps({
            'status': 'error',
            'message': str(exc),
            'trace': traceback.format_exc(),
            'logFile': str(log_path_for_error) if log_path_for_error else None,
        }))
        sys.exit(1)
