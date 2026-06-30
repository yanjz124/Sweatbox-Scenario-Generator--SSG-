import { useEffect, useState } from 'react';

interface UpdateInfo {
  latestVersion: string;
  currentVersion: string;
  releaseUrl: string;
  downloadUrl: string | null;
}

export function UpdateNotice() {
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    window.ssg.app
      .checkForUpdates()
      .then(res => {
        if (cancelled) return;
        if (!res.updateAvailable || !res.latestVersion) return;
        setInfo({
          latestVersion: res.latestVersion,
          currentVersion: res.currentVersion,
          releaseUrl: res.releaseUrl,
          downloadUrl: res.downloadUrl,
        });
      })
      .catch(() => {
        /* silent: a failed check shouldn't block the app */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => window.ssg.app.onUpdateProgress(p => setProgress(p)), []);

  const installNow = async () => {
    if (!info?.downloadUrl) { window.ssg.app.openExternal(info!.releaseUrl); return; }
    setErr(null);
    setProgress(0);
    const r = await window.ssg.app.downloadAndInstall(info.downloadUrl);
    if (!r.ok) { setErr(r.error || 'Download failed'); setProgress(null); }
    // on success the app launches the installer and quits.
  };

  if (!info || dismissed) return null;
  const downloading = progress !== null;

  return (
    <div
      style={{
        background: 'var(--accent, #3b82f6)',
        color: '#fff',
        padding: '8px 14px',
        fontSize: 13,
        borderRadius: 'var(--radius, 6px)',
        marginBottom: 12,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
      }}
    >
      <span>
        {err
          ? <>Update failed: {err}</>
          : downloading
            ? <>Downloading update… <strong>{Math.round((progress ?? 0) * 100)}%</strong>{progress === 1 ? ' — launching installer…' : ''}</>
            : <>A new version (<strong>{info.latestVersion}</strong>) is available. You are running {info.currentVersion}.</>}
      </span>
      <div style={{ display: 'flex', gap: 8 }}>
        <button
          type="button"
          disabled={downloading && !err}
          onClick={installNow}
          style={{
            background: 'rgba(255,255,255,0.18)',
            border: '1px solid rgba(255,255,255,0.45)',
            color: '#fff',
            padding: '4px 10px',
            borderRadius: 4,
            cursor: downloading && !err ? 'default' : 'pointer',
            opacity: downloading && !err ? 0.6 : 1,
            fontSize: 12,
            fontFamily: 'inherit',
          }}
        >
          {info.downloadUrl ? (downloading ? 'Installing…' : 'Download & install') : 'View release →'}
        </button>
        <button
          type="button"
          onClick={() => window.ssg.app.openExternal(info.releaseUrl)}
          style={{
            background: 'transparent',
            border: '1px solid rgba(255,255,255,0.45)',
            color: '#fff',
            padding: '4px 10px',
            borderRadius: 4,
            cursor: 'pointer',
            fontSize: 12,
            fontFamily: 'inherit',
          }}
        >
          Notes
        </button>
        <button
          type="button"
          onClick={() => setDismissed(true)}
          aria-label="Dismiss"
          style={{
            background: 'transparent',
            border: '1px solid rgba(255,255,255,0.45)',
            color: '#fff',
            padding: '4px 8px',
            borderRadius: 4,
            cursor: 'pointer',
            fontSize: 12,
            fontFamily: 'inherit',
          }}
        >
          ✕
        </button>
      </div>
    </div>
  );
}
