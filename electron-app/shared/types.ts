export type WakeCat = 'L' | 'M' | 'H';

export interface WakeBias {
  L: number;
  M: number;
  H: number;
}

export interface Flight {
  callsign: string;
  aircraftType: string;
  departure: string;
  arrival: string;
  route?: string;
  cruiseSpeed?: number;
  wakeCat?: WakeCat;
  [k: string]: unknown;
}

export type ScenarioType =
  | 'ground_departures'
  | 'ground_mixed'
  | 'tower_mixed'
  | 'tracon_arrivals'
  | 'tracon_mixed'
  | 'enroute'
  | 'live_replay';

export type SpawnDelayMode = 'none' | 'incremental' | 'total';

export interface DifficultyCounts {
  enabled: boolean;
  easy: number;
  medium: number;
  hard: number;
}

export type GaFlightRules = 'VFR' | 'IFR';

export interface GaDirection {
  count: number;
  mode: GaFlightRules;
}

export interface GaConfig {
  enabled: boolean;          // master toggle; when false, GA spots are skipped entirely
  departures: GaDirection;   // default { count: 0, mode: 'VFR' }
  arrivals: GaDirection;
}

/**
 * New add-row input types. The bridge still accepts the legacy string shapes
 * for backward-compat with saved configs, but the UI produces these directly.
 */
export interface WaypointStarPair {
  waypoint: string;
  star: string;
}

export interface FrdEntry {
  point: string;
  altitude: number | '';
  speed: number | '';
  initialRoute: string;
}

export interface AirportRunwaysEntry {
  icao: string;
  /** Raw user input (e.g. "08, 7R"). The Python bridge's `parse_runway_map`
   *  splits this on commas at submit time; storing the raw string avoids the
   *  eaten-comma-on-round-trip bug when the user is mid-typing. */
  runways: string;
  /** Enroute-only: number of aircraft to generate at this specific airport
   *  for this direction. Sum across airports becomes the scenario's total
   *  departure/arrival count. Defaults to 0 (airport present but contributes
   *  no aircraft) — use `''` for "not yet set" via the ThemedInput. */
  count?: number | '';
  /** Enroute arrivals only: override the scenario-wide spawn distance band
   *  for this airport (NM from destination). Leave both blank to use the
   *  scenario-wide `arrivalSpawn`. */
  spawnMinNm?: number | '';
  spawnMaxNm?: number | '';
  /** Enroute arrivals only: comma-separated 5-letter STAR prefixes (no
   *  trailing runway digit) to filter the flight pool. Empty = all STARs.
   *  Example: "EAGUL, HYDRR" matches EAGUL6, HYDRR3, etc. */
  arrivals?: string;
}

export interface SpawnDistanceBand {
  minDistanceNm: number;
  maxDistanceNm: number;
}

export type PresetGroupType =
  | 'all'
  | 'airline'
  | 'destination'
  | 'origin'
  | 'aircraft_type'
  | 'random'
  | 'departures'
  | 'arrivals'
  | 'parking'
  | 'sid'
  | 'star';

export interface PresetCommandRule {
  groupType: PresetGroupType;
  groupValue: string;
  commandTemplate: string;
}

export interface ScenarioConfig {
  departureAirport: string;
  arrivalAirport?: string;
  scenarioType: ScenarioType;

  numDepartures: number;
  numArrivals: number;
  /** Transient traffic: aircraft that spawn *inside* the ARTCC on random
   *  route waypoints and fly through. */
  numEnroute: number;
  /** Overflight traffic (enroute scenarios only): aircraft that spawn just
   *  OUTSIDE the ARTCC boundary and enter our airspace from the handoff
   *  point — they traverse the ARTCC but never land inside it. */
  numOverflight: number;

  activeRunways: string[];
  separationRange: number;

  spawnDelayEnabled: boolean;
  spawnDelayMode: SpawnDelayMode;
  incrementalDelayValue: string;
  totalSessionMinutes: number;

  arrivalMode: 'star' | 'frd';
  arrivalWaypoints: WaypointStarPair[];
  useCifpSpeeds: boolean;
  frd: FrdEntry[];

  enableVfr: boolean;
  numVfr: number;
  vfrSpawnLocations: string[];

  enableCifpSids: boolean;
  manualSids: string[];

  departureDifficulty: DifficultyCounts;
  arrivalDifficulty: DifficultyCounts;

  // Enroute-only — each list has one row per airport with the runways
  // served by that direction at that airport.
  arrivalAirports: AirportRunwaysEntry[];
  departureAirports: AirportRunwaysEntry[];
  enrouteDifficulty: DifficultyCounts;

  /** Enroute-only: distance (NM) from destination at which arrivals spawn.
   *  Per-airport overrides live on `AirportRunwaysEntry.spawnMinNm/Max`. */
  arrivalSpawn: SpawnDistanceBand;
  /** Enroute-only: distance (NM) outside the ARTCC boundary where overflight
   *  aircraft spawn. Random per aircraft between min and max. */
  overflightSpawn: SpawnDistanceBand;

  presetCommands: PresetCommandRule[];

  wakeBiasEnabled: boolean;
  wakeBias: WakeBias;

  ga: GaConfig;

  /** Enroute-only: optional user-defined polygon replacing the ARTCC
   *  boundary for all in/out/near-boundary checks (named after the vertices
   *  the user enters — waypoint identifiers resolved at generation time).
   *  Requires at least 4 waypoints when enabled. */
  customBoundary?: {
    enabled: boolean;
    waypoints: string[];
  };

  /** Live-replay only: path to the capture file produced by the capture flow.
   *  Set by the LiveCapture screen; consumed by the Python bridge's
   *  `live_replay` scenario type. */
  captureFile?: string;
  /** Live-replay only: pin each aircraft to its captured altitude when run
   *  uninterrupted (vs. following the filed climb/descent profile). */
  holdInitialAltitude?: boolean;
  /** Optional custom scenario name (used as the vNAS scenario title). */
  scenarioName?: string;
}

/** SFDPS credentials the user enters once so SSG can launch SwimServer. The
 *  password is write-only from the UI's perspective — load never returns it,
 *  only `hasPassword`. */
export interface SwimCredentialsInput {
  user: string;
  password: string;
  queue: string;
  host?: string;
  vpn?: string;
}

export interface SwimCredentialsStatus {
  user: string;
  queue: string;
  host: string;
  vpn: string;
  hasPassword: boolean;
  isComplete: boolean;
}

export interface CaptureRequest {
  facility: string;
  /** Blank or "ALL" = capture every sector in the facility. */
  sector?: string;
  windowSeconds: number;
  warmupSeconds: number;
  kml?: string;
  startServer?: boolean;
  /** Also capture non-owned traffic within this many NM of the sector(s). 0 = off. */
  vicinityNm?: number;
}

export interface CaptureResult {
  status: 'ok' | 'error';
  message?: string;
  captureFile?: string;
  recorded?: number;
  diagnostics?: {
    recorded?: number;
    skippedNoRoute?: number;
    skippedNoPosition?: number;
    activeSectorCount?: number;
    activeSectors?: string[];
    recordedBySector?: Record<string, number>;
    seenSectorsTop?: Record<string, number>;
  };
}

export interface CredentialTestResult {
  status: string;
  connected?: boolean;
  flights?: number;
  message?: string;
}

export interface SectorGeometry {
  sector: string;
  designator?: string;
  stratum?: string;
  floor?: number | null;
  ceiling?: number | null;
  /** [ring][point][lon, lat] */
  rings: number[][][];
}

export interface SectorGeometryResult {
  status: string;
  facility?: string;
  sectors?: SectorGeometry[];
  message?: string;
}

export interface VnasPosition {
  id: string;
  sectorId: string | null;
  name: string | null;
  callsign: string | null;
  frequency: number | null;
  facility: string | null;
}

export interface VnasPositionsResult {
  status: string;
  facility?: string;
  positions?: VnasPosition[];
  message?: string;
}

export interface AtcConfig {
  enabled: boolean;
  /** normalized sector id → vNAS position id (many sectors may share one). */
  sectorToPosition: Record<string, string>;
  fallbackPositionId?: string | null;
  /** Set each aircraft's handoffDelay from its captured handoff timeline. */
  handoffFromTimeline?: boolean;
  /** Positions the trainee works — auto-handoff (in/out) is disabled for
   *  aircraft owned by these, so the trainee does their own handoffs. The full
   *  capture data is preserved, so the same capture can target other sectors. */
  traineePositionIds?: string[];
}

export interface CaptureAircraft {
  gufi: string;
  callsign: string;
  firstSeenOffsetSec: number;
  membershipBasis?: string;
  category?: 'sector' | 'vicinity';
  aircraftType?: string | null;
  wake?: string | null;
  flightRules?: string | null;
  spawn: {
    lat: number | null;
    lon: number | null;
    altitudeFt: number | null;
    groundSpeedKt: number | null;
  };
  flightplan: {
    departure?: string | null;
    destination?: string | null;
    route?: string | null;
    star?: string | null;
    cruiseAltitudeFt?: number | null;
    assignedAltitudeFt?: number | null;
    cruiseSpeedKt?: number | null;
    remarks?: string | null;
    equipment?: string | null;
  };
  entry?: { controllingFacility?: string | null; controllingSector?: string | null };
  /** Observed ownership/handoff timeline during the capture window. */
  handoffs?: Array<{
    atOffsetSec: number;
    fromFacility?: string | null;
    fromSector?: string | null;
    toFacility?: string | null;
    toSector?: string | null;
  }>;
  /** Editor-only: whether to include this aircraft in the generated scenario. */
  include?: boolean;
}

export interface CaptureFile {
  version?: number;
  facility?: string;
  sector?: string;
  captureStart?: string;
  windowSeconds?: number;
  aircraft: CaptureAircraft[];
  /** Editor-set ATC mapping consumed by the live_replay generator. */
  atcConfig?: AtcConfig;
  [k: string]: unknown;
}

export interface GenerationStats {
  requested_total: number;
  actual_total: number;
  requested: Record<string, number>;
  actual: Record<string, number>;
  shortfall: Record<string, number>;
  /** Non-blocking configuration / generation warnings surfaced on the
   *  conclusion screen (runway/STAR mismatches, invalid STAR tokens,
   *  spawns that extended past the arrival band to maintain separation). */
  warnings?: string[];
  /** Purely informational notes surfaced on the conclusion screen. */
  notes?: string[];
}

export interface ScenarioResult {
  filename: string;
  contents: string;
  flightsUsed: Flight[];
  /** Count of aircraft in the generated scenario. Sourced from the Python
   *  bridge's `aircraft_count` field. For imported scenarios it defaults to
   *  `flightsUsed.length`. */
  aircraftCount: number;
  /** Enroute-only: per-type requested vs. actual counts. Lets the UI call
   *  out shortfalls when the pool couldn't satisfy every requested slot. */
  generationStats?: GenerationStats;
}

export interface VNASUploadResult {
  ok: boolean;
  status: number;
  message: string;
  scenarioId?: string;
}

/**
 * Shape of (the subset we care about of) config.json. The file carries more
 * fields (parking_airlines, less_common_airports, common_ga_aircraft) that
 * the Python side consumes directly — we only expose airport groups here.
 */
export interface SsgConfig {
  artcc_airport_groups?: Record<string, Record<string, string>>;
  [k: string]: unknown;
}

declare global {
  interface Window {
    ssg: {
      scenario: {
        generate(config: ScenarioConfig): Promise<ScenarioResult>;
        onProgress(
          cb: (ev: { stage: string; message: string; percent: number }) => void,
        ): () => void;
      };
      fs: {
        saveScenario(filename: string, contents: string): Promise<string>;
        openScenario(): Promise<{ filename: string; contents: string } | null>;
        loadConfig(): Promise<SsgConfig | null>;
        pickFile(options?: {
          title?: string;
          extensions?: string[];
        }): Promise<string | null>;
      };
      liveCapture: {
        saveCredentials(creds: SwimCredentialsInput): Promise<{ status: string; message?: string }>;
        loadCredentials(): Promise<SwimCredentialsStatus | null>;
        connect(): Promise<CredentialTestResult>;
        disconnect(): Promise<{ status: string; stopped?: boolean }>;
        serverStatus(): Promise<{ reachable: boolean; connected: boolean; flights: number; messages: number }>;
        getSectorGeometry(facility: string): Promise<SectorGeometryResult>;
        getPositions(facility: string): Promise<VnasPositionsResult>;
        getRouteSectors(
          facility: string,
          captureFile: string,
        ): Promise<{ status: string; routeSectors?: Record<string, string[]>; message?: string }>;
        readCapture(filePath: string): Promise<CaptureFile | null>;
        writeCapture(data: CaptureFile): Promise<string>;
        startCapture(req: CaptureRequest): Promise<CaptureResult>;
        stopCapture(): Promise<{ stopped: boolean }>;
        onProgress(
          cb: (ev: {
            elapsed: number;
            total: number;
            recorded: number;
            activeSectors: number;
            message: string;
          }) => void,
        ): () => void;
      };
      airports: {
        list(): Promise<Array<{ icao: string; filename: string }>>;
      };
      vnas: {
        upload(scenarioContents: string): Promise<VNASUploadResult>;
        reset(): Promise<void>;
        clearCookies(): Promise<void>;
      };
      app: {
        checkForUpdates(): Promise<{
          currentVersion: string;
          latestVersion: string | null;
          updateAvailable: boolean;
          releaseUrl: string;
          error?: string;
        }>;
        openExternal(url: string): Promise<void>;
      };
    };
  }
}
