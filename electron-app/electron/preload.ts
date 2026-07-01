import { contextBridge, ipcRenderer } from 'electron';
import type {
  ScenarioConfig,
  ScenarioResult,
  VNASUploadResult,
  SwimCredentialsInput,
  SwimCredentialsStatus,
  CaptureRequest,
  CaptureResult,
} from '../shared/types';

interface ProgressEvent {
  stage: string;
  message: string;
  percent: number;
}

contextBridge.exposeInMainWorld('ssg', {
  scenario: {
    generate: (config: ScenarioConfig): Promise<ScenarioResult> =>
      ipcRenderer.invoke('scenario:generate', config),
    onProgress: (cb: (ev: ProgressEvent) => void): (() => void) => {
      const listener = (_e: unknown, data: ProgressEvent) => cb(data);
      ipcRenderer.on('scenario:progress', listener);
      return () => ipcRenderer.removeListener('scenario:progress', listener);
    },
  },
  fs: {
    saveScenario: (filename: string, contents: string): Promise<string> =>
      ipcRenderer.invoke('fs:saveScenario', filename, contents),
    openScenario: (): Promise<{ filename: string; contents: string } | null> =>
      ipcRenderer.invoke('fs:openScenario'),
    loadConfig: (): Promise<unknown> => ipcRenderer.invoke('fs:loadConfig'),
    pickFile: (options?: { title?: string; extensions?: string[] }): Promise<string | null> =>
      ipcRenderer.invoke('fs:pickFile', options),
  },
  liveCapture: {
    saveCredentials: (creds: SwimCredentialsInput): Promise<{ status: string; message?: string }> =>
      ipcRenderer.invoke('liveCapture:saveCredentials', creds),
    loadCredentials: (): Promise<SwimCredentialsStatus | null> =>
      ipcRenderer.invoke('liveCapture:loadCredentials'),
    connect: (): Promise<{ status: string; connected?: boolean; flights?: number; message?: string }> =>
      ipcRenderer.invoke('liveCapture:connect'),
    disconnect: (): Promise<{ status: string; stopped?: boolean }> =>
      ipcRenderer.invoke('liveCapture:disconnect'),
    serverStatus: (): Promise<{ reachable: boolean; connected: boolean; flights: number; messages: number }> =>
      ipcRenderer.invoke('liveCapture:serverStatus'),
    getSectorGeometry: (facility: string) =>
      ipcRenderer.invoke('liveCapture:getSectorGeometry', facility),
    getPositions: (facility: string) => ipcRenderer.invoke('liveCapture:getPositions', facility),
    getRouteSectors: (facility: string, captureFile: string) =>
      ipcRenderer.invoke('liveCapture:getRouteSectors', facility, captureFile),
    listCaptures: () => ipcRenderer.invoke('liveCapture:listCaptures'),
    readCapture: (filePath: string) => ipcRenderer.invoke('liveCapture:readCapture', filePath),
    writeCapture: (data: unknown) => ipcRenderer.invoke('liveCapture:writeCapture', data),
    saveCapture: (filePath: string, data: unknown) => ipcRenderer.invoke('liveCapture:saveCapture', filePath, data),
    previewReplay: (captureFile: string) => ipcRenderer.invoke('liveCapture:previewReplay', captureFile),
    lowArrivals: (captureFile: string, altFt: number, distNm: number) =>
      ipcRenderer.invoke('liveCapture:lowArrivals', captureFile, altFt, distNm),
    deleteCapture: (filePath: string) => ipcRenderer.invoke('liveCapture:deleteCapture', filePath),
    startCapture: (req: CaptureRequest): Promise<CaptureResult> =>
      ipcRenderer.invoke('liveCapture:startCapture', req),
    stopCapture: (): Promise<{ stopped: boolean }> =>
      ipcRenderer.invoke('liveCapture:stopCapture'),
    onProgress: (
      cb: (ev: { elapsed: number; total: number; recorded: number; activeSectors: number; message: string }) => void,
    ): (() => void) => {
      const listener = (
        _e: unknown,
        data: { elapsed: number; total: number; recorded: number; activeSectors: number; message: string },
      ) => cb(data);
      ipcRenderer.on('liveCapture:progress', listener);
      return () => ipcRenderer.removeListener('liveCapture:progress', listener);
    },
  },
  airports: {
    list: () => ipcRenderer.invoke('airports:list'),
  },
  vnas: {
    upload: (scenarioContents: string): Promise<VNASUploadResult> =>
      ipcRenderer.invoke('vnas:upload', scenarioContents),
    dump: (outPath: string): Promise<{ ok: boolean; message: string }> =>
      ipcRenderer.invoke('vnas:dump', outPath),
    reset: (): Promise<void> => ipcRenderer.invoke('vnas:reset'),
    clearCookies: (): Promise<void> => ipcRenderer.invoke('vnas:clearCookies'),
  },
  app: {
    checkForUpdates: (): Promise<{
      currentVersion: string;
      latestVersion: string | null;
      updateAvailable: boolean;
      releaseUrl: string;
      downloadUrl: string | null;
      error?: string;
    }> => ipcRenderer.invoke('app:checkForUpdates'),
    downloadAndInstall: (url: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('app:downloadAndInstall', url),
    onUpdateProgress: (cb: (fraction: number) => void): (() => void) => {
      const h = (_e: unknown, p: number) => cb(p);
      ipcRenderer.on('app:updateProgress', h);
      return () => ipcRenderer.removeListener('app:updateProgress', h);
    },
    openExternal: (url: string): Promise<void> =>
      ipcRenderer.invoke('app:openExternal', url),
  },
});
