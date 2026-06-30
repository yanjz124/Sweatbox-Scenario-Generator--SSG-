import { app, BrowserWindow, ipcMain, dialog, shell } from 'electron';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { generateScenario } from './ipc/scenario';
import { listAirports } from './ipc/airports';
import { uploadScenario, resetVnasSession, clearVnasCookies, dumpScenario } from './ipc/vnas';
import { saveCredentials, loadCredentials, startCapture, stopCapture, connect, disconnect, serverStatus, getSectorGeometry, getPositions, getRouteSectors, killCapture } from './ipc/liveCapture';
import type {
  ScenarioConfig,
  SwimCredentialsInput,
  CaptureRequest,
} from '../shared/types';

// Fork build: track releases from the fork (yanjz124), not upstream, so the
// updater doesn't offer to "downgrade" to the upstream version.
const RELEASES_API =
  'https://api.github.com/repos/yanjz124/Sweatbox-Scenario-Generator--SSG-/releases/latest';
const RELEASES_HTML =
  'https://github.com/yanjz124/Sweatbox-Scenario-Generator--SSG-/releases/latest';

function compareSemver(a: string, b: string): number {
  const parts = (s: string) =>
    s.trim().replace(/^v/i, '').split(/[.-]/).map(p => parseInt(p, 10) || 0);
  const aa = parts(a);
  const bb = parts(b);
  const n = Math.max(aa.length, bb.length);
  for (let i = 0; i < n; i++) {
    const av = aa[i] ?? 0;
    const bv = bb[i] ?? 0;
    if (av > bv) return 1;
    if (av < bv) return -1;
  }
  return 0;
}

async function checkForUpdates(): Promise<{
  currentVersion: string;
  latestVersion: string | null;
  updateAvailable: boolean;
  releaseUrl: string;
  error?: string;
}> {
  const currentVersion = app.getVersion();
  try {
    const res = await fetch(RELEASES_API, {
      headers: { Accept: 'application/vnd.github+json' },
    });
    if (!res.ok) {
      return {
        currentVersion,
        latestVersion: null,
        updateAvailable: false,
        releaseUrl: RELEASES_HTML,
        error: `GitHub responded ${res.status}`,
      };
    }
    const data = (await res.json()) as { tag_name?: string; html_url?: string };
    const latestVersion = (data.tag_name || '').replace(/^v/i, '') || null;
    const releaseUrl = data.html_url || RELEASES_HTML;
    const updateAvailable =
      !!latestVersion && compareSemver(latestVersion, currentVersion) > 0;
    return { currentVersion, latestVersion, updateAvailable, releaseUrl };
  } catch (err) {
    return {
      currentVersion,
      latestVersion: null,
      updateAvailable: false,
      releaseUrl: RELEASES_HTML,
      error: String(err),
    };
  }
}

const isDev = !app.isPackaged;

async function createWindow() {
  const win = new BrowserWindow({
    width: 900,
    height: 1000,
    minWidth: 800,
    minHeight: 900,
    title: 'vNAS Sweatbox Scenario Generator',
    icon: path.join(__dirname, '..', '..', 'logo.ico'),
    backgroundColor: '#1e1e1e',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.once('ready-to-show', () => win.show());
  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.error('[main] did-fail-load', { code, desc, url });
    win.show();
  });

  try {
    if (isDev) {
      await win.loadURL('http://localhost:5173');
      win.webContents.openDevTools({ mode: 'detach' });
    } else {
      await win.loadFile(path.join(__dirname, '../../dist/index.html'));
    }
  } catch (err) {
    console.error('[main] window load failed:', err);
    win.show();
  }
}

process.on('uncaughtException', err => console.error('[main] uncaughtException', err));
process.on('unhandledRejection', err => console.error('[main] unhandledRejection', err));

function registerIpc() {
  ipcMain.handle('scenario:generate', (e, config: ScenarioConfig) =>
    generateScenario(config, progress => {
      if (!e.sender.isDestroyed()) {
        e.sender.send('scenario:progress', progress);
      }
    }),
  );
  ipcMain.handle('airports:list', () => listAirports());
  ipcMain.handle('fs:saveScenario', async (_e, filename: string, contents: string) => {
    const res = await dialog.showSaveDialog({ defaultPath: filename });
    if (res.canceled || !res.filePath) return '';
    await fs.writeFile(res.filePath, contents, 'utf8');
    return res.filePath;
  });
  ipcMain.handle('fs:loadConfig', async () => {
    // Return the app's config.json so the renderer can surface user-defined
    // enroute airport groups, parking-airline defaults, etc. In packaged
    // mode we prefer the user-editable copy next to the exe (same dir as
    // the rest of airport_data), falling back to the bundled default.
    const candidates = app.isPackaged
      ? [path.join(process.resourcesPath, 'config.json')]
      : [path.resolve(__dirname, '..', '..', '..', '..', 'config.json')];
    for (const p of candidates) {
      try {
        const raw = await fs.readFile(p, 'utf8');
        return JSON.parse(raw);
      } catch {
        /* try next */
      }
    }
    return null;
  });
  ipcMain.handle('fs:openScenario', async () => {
    const res = await dialog.showOpenDialog({
      title: 'Open scenario JSON',
      filters: [
        { name: 'Scenario JSON', extensions: ['json'] },
        { name: 'All files', extensions: ['*'] },
      ],
      properties: ['openFile'],
    });
    if (res.canceled || !res.filePaths[0]) return null;
    const filePath = res.filePaths[0];
    const contents = await fs.readFile(filePath, 'utf8');
    return { filename: path.basename(filePath), contents };
  });
  ipcMain.handle('fs:pickFile', async (_e, options?: { title?: string; extensions?: string[] }) => {
    const exts = options?.extensions && options.extensions.length > 0 ? options.extensions : ['*'];
    const res = await dialog.showOpenDialog({
      title: options?.title ?? 'Select a file',
      filters: [{ name: 'Files', extensions: exts }, { name: 'All files', extensions: ['*'] }],
      properties: ['openFile'],
    });
    if (res.canceled || !res.filePaths[0]) return null;
    return res.filePaths[0];
  });
  ipcMain.handle('liveCapture:saveCredentials', (_e, creds: SwimCredentialsInput) =>
    saveCredentials(creds),
  );
  ipcMain.handle('liveCapture:loadCredentials', () => loadCredentials());
  ipcMain.handle('liveCapture:connect', () => connect());
  ipcMain.handle('liveCapture:disconnect', () => disconnect());
  ipcMain.handle('liveCapture:serverStatus', () => serverStatus());
  ipcMain.handle('liveCapture:getSectorGeometry', (_e, facility: string) => getSectorGeometry(facility));
  ipcMain.handle('liveCapture:getPositions', (_e, facility: string) => getPositions(facility));
  ipcMain.handle('liveCapture:getRouteSectors', (_e, facility: string, captureFile: string) =>
    getRouteSectors(facility, captureFile),
  );
  ipcMain.handle('liveCapture:listCaptures', async () => {
    const dir = path.join(app.getPath('userData'), 'captures');
    try {
      const files = (await fs.readdir(dir)).filter(f => f.endsWith('.capture.json'));
      const out = [];
      for (const f of files) {
        const p = path.join(dir, f);
        try {
          const st = await fs.stat(p);
          const j = JSON.parse(await fs.readFile(p, 'utf8'));
          out.push({
            path: p,
            filename: f,
            facility: j.facility ?? '',
            sector: j.sector ?? '',
            aircraftCount: Array.isArray(j.aircraft) ? j.aircraft.length : 0,
            captureStart: j.captureStart ?? '',
            mtimeMs: st.mtimeMs,
          });
        } catch {
          /* skip unreadable file */
        }
      }
      out.sort((a, b) => b.mtimeMs - a.mtimeMs);
      return out;
    } catch {
      return [];
    }
  });
  ipcMain.handle('liveCapture:readCapture', async (_e, filePath: string) => {
    try {
      return JSON.parse(await fs.readFile(filePath, 'utf8'));
    } catch {
      return null;
    }
  });
  ipcMain.handle('liveCapture:writeCapture', async (_e, data: unknown) => {
    const dir = path.join(app.getPath('userData'), 'captures');
    await fs.mkdir(dir, { recursive: true });
    const out = path.join(dir, `edited-${Date.now()}.capture.json`);
    await fs.writeFile(out, JSON.stringify(data, null, 2), 'utf8');
    return out;
  });
  ipcMain.handle('liveCapture:deleteCapture', async (_e, filePath: string) => {
    // Only allow deleting files inside the app's captures dir.
    const dir = path.join(app.getPath('userData'), 'captures');
    const resolved = path.resolve(filePath);
    if (path.dirname(resolved) !== path.resolve(dir)) {
      return { ok: false, message: 'refused: outside captures directory' };
    }
    try {
      await fs.unlink(resolved);
      return { ok: true };
    } catch (e) {
      return { ok: false, message: String(e) };
    }
  });
  ipcMain.handle('liveCapture:stopCapture', () => stopCapture());
  ipcMain.handle('liveCapture:startCapture', (e, req: CaptureRequest) =>
    startCapture(req, progress => {
      if (!e.sender.isDestroyed()) {
        e.sender.send('liveCapture:progress', progress);
      }
    }),
  );
  ipcMain.handle('vnas:upload', (_e, contents: string) => uploadScenario(contents));
  ipcMain.handle('vnas:dump', (_e, outPath: string) => dumpScenario(outPath));
  ipcMain.handle('vnas:reset', () => resetVnasSession());
  ipcMain.handle('vnas:clearCookies', () => clearVnasCookies());
  ipcMain.handle('app:checkForUpdates', () => checkForUpdates());
  ipcMain.handle('app:openExternal', (_e, url: string) => shell.openExternal(url));
}

app.whenReady().then(() => {
  registerIpc();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => {
  // Kill any running capture child first so it isn't orphaned (orphans keep
  // streaming progress and double up the next run).
  killCapture();
  // Best-effort: stop the warm SwimServer so it doesn't linger after SSG exits.
  disconnect().catch(() => {});
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
