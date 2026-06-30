import { spawn, type ChildProcess } from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import { app } from 'electron';
import { resolveBridgeCommand } from './scenario';
import type {
  SwimCredentialsInput,
  SwimCredentialsStatus,
  CaptureRequest,
  CaptureResult,
} from '../../shared/types';

export interface CaptureProgress {
  elapsed: number;
  total: number;
  recorded: number;
  activeSectors: number;
  message: string;
}
export type CaptureProgressCallback = (ev: CaptureProgress) => void;

// Path to the stop-file for the in-flight capture (set while a capture runs);
// `stopCapture` touches it so the bridge ends the capture gracefully.
let currentStopFile: string | null = null;
// Handle to the running capture subprocess so we can hard-kill it on quit
// (Node does NOT kill spawned children when the app exits → orphaned captures
// that keep streaming progress and double up the next run).
let currentCaptureProc: ChildProcess | null = null;

interface BridgeActionResult {
  status: string;
  message?: string;
  [k: string]: unknown;
}

/**
 * Run a non-generation bridge action (save_credentials / load_credentials /
 * capture). Writes the payload to a temp config file and spawns the same
 * ssg_bridge exe used for generation. For `capture`, stderr lines of the form
 * "Capture progress: e/Ts recorded=N" drive the progress callback.
 */
async function runBridgeAction(
  payload: Record<string, unknown>,
  onProgress?: CaptureProgressCallback,
  onSpawn?: (proc: ChildProcess) => void,
): Promise<BridgeActionResult> {
  const { cmd, args, cwd } = resolveBridgeCommand();
  const tmpFile = path.join(os.tmpdir(), `ssg-action-${Date.now()}.json`);
  await fs.writeFile(tmpFile, JSON.stringify(payload, null, 2), 'utf8');

  const PROGRESS_RE = /Capture progress:\s*(\d+)\/(\d+)s\s*recorded=(\d+)\s*sectors=(\d+)/i;

  try {
    return await new Promise<BridgeActionResult>((resolve, reject) => {
      const proc = spawn(cmd, [...args, tmpFile], {
        cwd,
        env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
      });
      if (onSpawn) onSpawn(proc);
      let stdout = '';
      let stderr = '';
      let stderrBuf = '';

      const emitFromLine = (line: string) => {
        if (!onProgress || !line) return;
        const m = line.match(PROGRESS_RE);
        if (m) {
          const elapsed = parseInt(m[1], 10);
          const total = parseInt(m[2], 10);
          const recorded = parseInt(m[3], 10);
          const activeSectors = parseInt(m[4], 10);
          onProgress({
            elapsed,
            total,
            recorded,
            activeSectors,
            message: `Capturing… ${elapsed}/${total}s · ${recorded} aircraft · ${activeSectors} sectors`,
          });
        }
      };

      proc.stdout.on('data', d => (stdout += d.toString()));
      proc.stderr.on('data', d => {
        const text = d.toString();
        stderr += text;
        stderrBuf += text;
        const lines = stderrBuf.split(/\r?\n/);
        stderrBuf = lines.pop() ?? '';
        for (const line of lines) emitFromLine(line);
      });
      proc.on('error', reject);
      proc.on('close', code => {
        if (stderrBuf) emitFromLine(stderrBuf);
        const lastLine = stdout.trim().split(/\r?\n/).pop() ?? '';
        try {
          resolve(JSON.parse(lastLine) as BridgeActionResult);
        } catch {
          resolve({
            status: 'error',
            message: `bridge exited ${code}; stderr: ${stderr.slice(-2000)}`,
          });
        }
      });
    });
  } finally {
    fs.unlink(tmpFile).catch(() => {});
  }
}

export async function saveCredentials(
  creds: SwimCredentialsInput,
): Promise<{ status: string; message?: string }> {
  return runBridgeAction({ action: 'save_credentials', ...creds });
}

export async function loadCredentials(): Promise<SwimCredentialsStatus | null> {
  const r = await runBridgeAction({ action: 'load_credentials' });
  if (r.status !== 'ok') return null;
  return {
    user: (r.user as string) ?? '',
    queue: (r.queue as string) ?? '',
    host: (r.host as string) ?? '',
    vpn: (r.vpn as string) ?? '',
    hasPassword: Boolean(r.hasPassword),
    isComplete: Boolean(r.isComplete),
  };
}

export interface SectorGeometry {
  sector: string;
  designator?: string;
  stratum?: string;
  floor?: number | null;
  ceiling?: number | null;
  rings: number[][][]; // [ring][point][lon,lat]
}

export async function getSectorGeometry(
  facility: string,
): Promise<{ status: string; facility?: string; sectors?: SectorGeometry[]; message?: string }> {
  return runBridgeAction({ action: 'get_sectors', facility });
}

export interface VnasPosition {
  id: string;
  sectorId: string | null;
  name: string | null;
  callsign: string | null;
  frequency: number | null;
  facility: string | null;
}

export async function getPositions(
  facility: string,
): Promise<{ status: string; facility?: string; positions?: VnasPosition[]; message?: string }> {
  return runBridgeAction({ action: 'get_positions', facility });
}

export async function getRouteSectors(
  facility: string,
  captureFile: string,
): Promise<{ status: string; routeSectors?: Record<string, string[]>; message?: string }> {
  return runBridgeAction({ action: 'route_sectors', facility, captureFile });
}

export async function connect(): Promise<{
  status: string;
  connected?: boolean;
  flights?: number;
  message?: string;
}> {
  return runBridgeAction({ action: 'connect' });
}

export async function disconnect(): Promise<{ status: string; stopped?: boolean }> {
  return runBridgeAction({ action: 'disconnect' });
}

/** Live status poll — hits SwimServer's /api/stats directly (no bridge spawn). */
export async function serverStatus(): Promise<{
  reachable: boolean;
  connected: boolean;
  flights: number;
  messages: number;
}> {
  try {
    const res = await fetch('http://localhost:5001/api/stats', {
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return { reachable: false, connected: false, flights: 0, messages: 0 };
    const s = (await res.json()) as { connected?: boolean; flights?: number; total?: number };
    return {
      reachable: true,
      connected: !!s.connected,
      flights: s.flights ?? 0,
      messages: s.total ?? 0,
    };
  } catch {
    return { reachable: false, connected: false, flights: 0, messages: 0 };
  }
}

export async function startCapture(
  req: CaptureRequest,
  onProgress?: CaptureProgressCallback,
): Promise<CaptureResult> {
  // Refuse a second concurrent capture — two bridges streaming progress to one
  // bar makes it jump back and forth (and doubles SwimServer load).
  if (currentStopFile) {
    return { status: 'error', message: 'A capture is already running. End it before starting another.' } as CaptureResult;
  }
  const outputDir = path.join(app.getPath('userData'), 'captures');
  await fs.mkdir(outputDir, { recursive: true });
  const stopFile = path.join(os.tmpdir(), `ssg-stop-${Date.now()}`);
  currentStopFile = stopFile;
  try {
    const r = await runBridgeAction(
      { action: 'capture', startServer: true, ...req, outputDir, stopFile },
      onProgress,
      proc => { currentCaptureProc = proc; },
    );
    return r as CaptureResult;
  } finally {
    currentStopFile = null;
    currentCaptureProc = null;
    fs.unlink(stopFile).catch(() => {});
  }
}

/** Hard-stop any running capture subprocess — called on app quit so a capture
 *  is never orphaned (which would keep streaming and double the next run). */
export function killCapture(): void {
  if (currentCaptureProc) {
    try { currentCaptureProc.kill(); } catch { /* already gone */ }
    currentCaptureProc = null;
  }
  currentStopFile = null;
}

/** "End now": touch the stop-file so the running capture finishes gracefully. */
export async function stopCapture(): Promise<{ stopped: boolean }> {
  if (!currentStopFile) return { stopped: false };
  try {
    await fs.writeFile(currentStopFile, 'stop', 'utf8');
    return { stopped: true };
  } catch {
    return { stopped: false };
  }
}
