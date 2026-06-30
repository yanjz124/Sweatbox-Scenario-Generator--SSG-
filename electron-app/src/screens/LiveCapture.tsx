import type React from 'react';
import { useEffect, useRef, useState } from 'react';
import { useScenarioStore } from '../state/scenarioStore';
import { Card, Section, ThemedButton, ThemedInput } from '../components/Themed';
import { LiveScope } from '../components/LiveScope';
import type { CaptureResult, SwimCredentialsStatus } from '../../shared/types';

type CaptureState =
  | { kind: 'idle' }
  | { kind: 'scheduled'; targetMs: number; leadMs: number }
  | { kind: 'running'; elapsed: number; total: number; recorded: number; sectors: number }
  | { kind: 'done'; result: CaptureResult }
  | { kind: 'error'; message: string };

const labelStyle: React.CSSProperties = {
  fontSize: 12,
  color: 'var(--fg-secondary)',
  marginBottom: 4,
  display: 'block',
};

function normSec(s: string): string {
  const t = (s || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase().replace(/^0+/, '');
  return t || '0';
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: 'block' }}>
      <span style={labelStyle}>{label}</span>
      {children}
    </label>
  );
}

const MAP_URL = 'http://localhost:5001/eram';

/** Parse a datetime-local string ("YYYY-MM-DDTHH:mm") as UTC/Zulu → epoch ms. */
function parseZulu(s: string): number | null {
  if (!s) return null;
  const ms = Date.parse(`${s.length === 16 ? `${s}:00` : s}Z`);
  return Number.isNaN(ms) ? null : ms;
}

function fmtCountdown(ms: number): string {
  if (ms <= 0) return '0s';
  const t = Math.floor(ms / 1000);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  return [h ? `${h}h` : '', m ? `${m}m` : '', `${s}s`].filter(Boolean).join(' ');
}

export function LiveCapture() {
  const { config, update, setScreen } = useScenarioStore();

  // ── credentials ──
  const [creds, setCreds] = useState<SwimCredentialsStatus | null>(null);
  const [user, setUser] = useState('');
  const [password, setPassword] = useState('');
  const [queue, setQueue] = useState('');
  const [credSaved, setCredSaved] = useState<string | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [host, setHost] = useState('');
  const [vpn, setVpn] = useState('');
  const [connecting, setConnecting] = useState(false);
  const [connectMsg, setConnectMsg] = useState<string | null>(null);
  const [srv, setSrv] = useState<{ reachable: boolean; connected: boolean; flights: number; messages: number }>({
    reachable: false,
    connected: false,
    flights: 0,
    messages: 0,
  });

  // ── capture params ──
  const [facility, setFacility] = useState(config.departureAirport || '');
  const [allSectors, setAllSectors] = useState(true);
  const [sector, setSector] = useState('');
  const [windowMin, setWindowMin] = useState(30);
  // Flight-plan coverage of the target traffic (warm-up readiness, % based).
  const [readiness, setReadiness] = useState<{ total: number; withPlan: number }>({ total: 0, withPlan: 0 });
  const [hold, setHold] = useState(config.holdInitialAltitude ?? false);
  const [scenarioName, setScenarioName] = useState('');
  const [vicinityEnabled, setVicinityEnabled] = useState(false);
  const [vicinityNm, setVicinityNm] = useState(40);

  // ── schedule ──
  const [scheduleEnabled, setScheduleEnabled] = useState(false);
  const [startUtc, setStartUtc] = useState('');
  const [now, setNow] = useState(Date.now());

  const [capture, setCapture] = useState<CaptureState>({ kind: 'idle' });
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    (async () => {
      const c = await window.ssg.liveCapture.loadCredentials();
      if (c) {
        setCreds(c);
        setUser(c.user);
        setQueue(c.queue);
        setHost(c.host);
        setVpn(c.vpn);
      }
    })();
  }, []);

  // Tick for countdown displays.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  // Cleanup any pending scheduled timer on unmount.
  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);

  // Warm-up readiness: while connected (and not capturing), watch what % of the
  // TARGET traffic already has a complete flight plan — capture when it's high.
  useEffect(() => {
    if (!srv.connected || capture.kind === 'running') return;
    const fac = facility.trim().toUpperCase();
    const sel = new Set(allSectors ? [] : sector.split(',').map(s => normSec(s)).filter(Boolean));
    const inTarget = (f: Record<string, unknown>) => {
      if (((f.controllingFacility as string) || '').toUpperCase() !== fac) return false;
      return allSectors || sel.has(normSec((f.controllingSector as string) || ''));
    };
    const complete = (f: Record<string, unknown>) =>
      !!((f.route as string) || (f.originalRoute as string)) && !!f.aircraftType && !!f.destination &&
      (f.requestedAltitude != null || f.assignedAltitude != null);
    const map = new Map<string, Record<string, unknown>>();
    let ws: WebSocket | null = null;
    try { ws = new WebSocket('ws://localhost:5001/ws'); } catch { return; }
    ws.onmessage = ev => {
      try {
        const m = JSON.parse(ev.data as string);
        if ((m.type === 'snapshot' || m.type === 'batch') && Array.isArray(m.data)) {
          for (const f of m.data) if (f.gufi) map.set(f.gufi, f);
        } else if (m.type === 'remove') {
          const d = m.data; const ids = Array.isArray(d) ? d : [d];
          for (const x of ids) map.delete(typeof x === 'string' ? x : x?.gufi);
        }
      } catch { /* ignore */ }
    };
    const id = setInterval(() => {
      let total = 0, withPlan = 0;
      for (const f of map.values()) if (inTarget(f)) { total++; if (complete(f)) withPlan++; }
      setReadiness({ total, withPlan });
    }, 1500);
    return () => { clearInterval(id); try { ws?.close(); } catch { /* ignore */ } };
  }, [srv.connected, capture.kind, facility, allSectors, sector]);

  const credsComplete = !!user.trim() && !!queue.trim() && (!!password.trim() || !!creds?.hasPassword);

  const saveCreds = async () => {
    setCredSaved(null);
    const r = await window.ssg.liveCapture.saveCredentials({
      user: user.trim(),
      password,
      queue: queue.trim(),
      host: host.trim() || undefined,
      vpn: vpn.trim() || undefined,
    });
    if (r.status === 'ok') {
      setCredSaved('Credentials saved.');
      const c = await window.ssg.liveCapture.loadCredentials();
      if (c) setCreds(c);
      setPassword('');
    } else {
      setCredSaved(`Error: ${r.message ?? 'failed to save'}`);
    }
  };

  // Poll the warm server's status every few seconds.
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      const s = await window.ssg.liveCapture.serverStatus();
      if (alive) setSrv(s);
    };
    tick();
    const id = setInterval(tick, 3000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  const doConnect = async () => {
    setConnecting(true);
    setConnectMsg(null);
    try {
      await saveCreds(); // use current form values
      const r = await window.ssg.liveCapture.connect();
      setConnectMsg(r.message ?? (r.status === 'ok' ? 'Connected.' : 'Connect failed.'));
      setSrv(await window.ssg.liveCapture.serverStatus());
    } catch (e) {
      setConnectMsg(String(e));
    } finally {
      setConnecting(false);
    }
  };

  const doDisconnect = async () => {
    await window.ssg.liveCapture.disconnect();
    setConnectMsg('Disconnected.');
    setSrv({ reachable: false, connected: false, flights: 0, messages: 0 });
  };

  const runCapture = async (windowSeconds: number, warmupSeconds: number) => {
    setCapture({ kind: 'running', elapsed: 0, total: windowSeconds, recorded: 0, sectors: 0 });
    const unsubscribe = window.ssg.liveCapture.onProgress(ev => {
      setCapture({
        kind: 'running',
        elapsed: ev.elapsed,
        total: ev.total,
        recorded: ev.recorded,
        sectors: ev.activeSectors,
      });
    });
    try {
      const result = await window.ssg.liveCapture.startCapture({
        facility: facility.trim().toUpperCase(),
        sector: allSectors ? 'ALL' : sector.trim(),
        windowSeconds,
        warmupSeconds,
        startServer: true,
        vicinityNm: vicinityEnabled ? vicinityNm : 0,
      });
      setCapture(
        result.status === 'ok'
          ? { kind: 'done', result }
          : { kind: 'error', message: result.message ?? 'capture failed' },
      );
    } catch (e) {
      setCapture({ kind: 'error', message: String(e) });
    } finally {
      unsubscribe();
    }
  };

  const onStart = () => {
    const windowSeconds = Math.max(1, Math.round(windowMin * 60));
    const warmupSeconds = 0; // server is already warmed via Connect; coverage gauge shows readiness
    if (!scheduleEnabled) {
      void runCapture(windowSeconds, warmupSeconds);
      return;
    }
    // Scheduled: wait until (start − warmup), then capture (warmup runs into start).
    const targetMs = parseZulu(startUtc);
    if (!targetMs) {
      setCapture({ kind: 'error', message: 'Enter a valid start time (UTC).' });
      return;
    }
    const leadMs = targetMs;
    const delay = Math.max(0, leadMs - Date.now());
    setCapture({ kind: 'scheduled', targetMs, leadMs });
    timerRef.current = setTimeout(() => void runCapture(windowSeconds, warmupSeconds), delay);
  };

  const cancelSchedule = () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
    setCapture({ kind: 'idle' });
  };

  const endNow = async () => {
    if (!window.confirm('End capture now? Aircraft captured so far are kept and can be generated.')) return;
    await window.ssg.liveCapture.stopCapture();
  };

  const applyCaptureToConfig = () => {
    if (capture.kind !== 'done' || !capture.result.captureFile) return false;
    update({
      scenarioType: 'live_replay',
      captureFile: capture.result.captureFile,
      holdInitialAltitude: hold,
      scenarioName: scenarioName.trim() || undefined,
    });
    return true;
  };
  const proceedToGenerate = () => {
    if (applyCaptureToConfig()) setScreen('generation');
  };
  const proceedToEdit = () => {
    if (applyCaptureToConfig()) setScreen('edit');
  };

  const openMap = () => window.ssg.app.openExternal(MAP_URL);

  const canStart =
    srv.connected &&
    !!facility.trim() &&
    (allSectors || !!sector.trim()) &&
    (!scheduleEnabled || !!parseZulu(startUtc)) &&
    capture.kind !== 'running' &&
    capture.kind !== 'scheduled';

  const pct =
    capture.kind === 'running' && capture.total > 0
      ? Math.min(100, (capture.elapsed / capture.total) * 100)
      : 0;

  return (
    <Card title="Live Replay — Capture">
      <p style={{ color: 'var(--fg-secondary)', margin: '0 0 16px' }}>
        Capture live real-world traffic in a facility over a time window, then replay it in vNAS from
        each aircraft's real position and altitude. SSG launches SwimServer locally using your FAA
        SWIM (SFDPS) credentials.
      </p>

      <div className="stack" style={{ gap: 20 }}>
        <Section title="SWIM Credentials (SFDPS)">
          <div className="stack" style={{ gap: 10 }}>
            <Field label="Username / email">
              <ThemedInput value={user} onChange={e => setUser(e.target.value)} placeholder="you@example.com" />
            </Field>
            <Field label={creds?.hasPassword ? 'Password (saved — leave blank to keep)' : 'Password'}>
              <ThemedInput
                type="password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                placeholder={creds?.hasPassword ? '•••••••• (stored)' : 'SWIM password'}
              />
            </Field>
            <Field label="Queue name">
              <ThemedInput value={queue} onChange={e => setQueue(e.target.value)} placeholder="you.FDPS.<uuid>.OUT" />
            </Field>
            {showAdvanced && (
              <>
                <Field label="Host (advanced)">
                  <ThemedInput value={host} onChange={e => setHost(e.target.value)} placeholder="tcps://ems2.swim.faa.gov:55443" />
                </Field>
                <Field label="VPN (advanced)">
                  <ThemedInput value={vpn} onChange={e => setVpn(e.target.value)} placeholder="FDPS" />
                </Field>
              </>
            )}
            <div className="row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <ThemedButton onClick={saveCreds}>Save</ThemedButton>
              {srv.connected || srv.reachable ? (
                <ThemedButton secondary onClick={doDisconnect}>Disconnect</ThemedButton>
              ) : (
                <ThemedButton onClick={doConnect} disabled={!credsComplete || connecting}>
                  {connecting ? 'Connecting…' : 'Connect / Test'}
                </ThemedButton>
              )}
              <ThemedButton secondary onClick={() => setShowAdvanced(v => !v)}>
                {showAdvanced ? 'Hide advanced' : 'Advanced…'}
              </ThemedButton>
              {credSaved && (
                <span style={{ fontSize: 12, color: credSaved.startsWith('Error') ? 'var(--error)' : 'var(--success, #6c6)' }}>
                  {credSaved}
                </span>
              )}
            </div>
            {/* live status pill */}
            <div style={{ fontSize: 13 }}>
              {srv.connected ? (
                <span style={{ color: 'var(--success, #6c6)' }}>
                  ● Connected — {srv.flights} flights, {srv.messages} msgs (warming up)
                </span>
              ) : srv.reachable ? (
                <span style={{ color: 'var(--warning, #c77)' }}>● Server up — authenticating / no data yet</span>
              ) : (
                <span style={{ color: 'var(--fg-secondary)' }}>○ Not connected</span>
              )}
            </div>
            {connecting && (
              <p style={{ fontSize: 12, color: 'var(--fg-secondary)', margin: 0 }}>
                Launching SwimServer and connecting to the SWIM feed… (~30–60s)
              </p>
            )}
            {connectMsg && <p style={{ fontSize: 12, color: 'var(--fg-secondary)', margin: 0 }}>{connectMsg}</p>}
          </div>
        </Section>

        <Section title="Facility & Sectors">
          <div className="row" style={{ gap: 10, alignItems: 'flex-end' }}>
            <div style={{ flex: 1 }}>
              <Field label="Facility (ARTCC)">
                <ThemedInput value={facility} onChange={e => setFacility(e.target.value)} placeholder="ZKC" />
              </Field>
            </div>
            {!allSectors && (
              <div style={{ flex: 2 }}>
                <Field label="Sector(s) — comma-separated">
                  <ThemedInput value={sector} onChange={e => setSector(e.target.value)} placeholder="e.g. 60, 72, 7" />
                </Field>
              </div>
            )}
          </div>
          <label className="row" style={{ gap: 8, alignItems: 'center', fontSize: 13, marginTop: 8 }}>
            <input type="checkbox" checked={allSectors} onChange={e => setAllSectors(e.target.checked)} />
            Capture all sectors in the facility (recommended)
          </label>
          <label className="row" style={{ gap: 8, alignItems: 'center', fontSize: 13 }}>
            <input type="checkbox" checked={vicinityEnabled} onChange={e => setVicinityEnabled(e.target.checked)} />
            Also capture nearby (vicinity) traffic within
            <ThemedInput
              type="number"
              min={0}
              style={{ width: 64 }}
              value={vicinityNm}
              onChange={e => setVicinityNm(Number(e.target.value) || 0)}
              disabled={!vicinityEnabled}
            />
            NM (curate in the editor)
          </label>
          {srv.connected && capture.kind !== 'running' && (() => {
            const pct = readiness.total ? Math.round((100 * readiness.withPlan) / readiness.total) : 0;
            const good = pct >= 80;
            return (
              <div style={{ marginTop: 8, fontSize: 13, color: good ? 'var(--success, #6c6)' : 'var(--warning, #c77)' }}>
                Flight-plan coverage: <strong>{readiness.withPlan}/{readiness.total}</strong>
                {readiness.total ? ` (${pct}%)` : ''} of {facility.trim().toUpperCase() || 'target'} traffic ready
                {readiness.total === 0 ? ' — warming up…' : good ? ' — good to capture' : ' — let it warm up more'}
              </div>
            );
          })()}
        </Section>

        <Section title="Capture Settings">
          <Field label="Duration (minutes)">
            <ThemedInput type="number" min={1} value={windowMin} onChange={e => setWindowMin(Number(e.target.value) || 0)} />
          </Field>
          <label className="row" style={{ gap: 8, alignItems: 'center', fontSize: 13 }}>
            <input type="checkbox" checked={hold} onChange={e => setHold(e.target.checked)} />
            Hold initial altitude when uninterrupted (vs. follow filed climb/descent profile)
          </label>
        </Section>

        <Section title="Schedule (optional)">
          <label className="row" style={{ gap: 8, alignItems: 'center', fontSize: 13 }}>
            <input type="checkbox" checked={scheduleEnabled} onChange={e => setScheduleEnabled(e.target.checked)} />
            Schedule a start time (warm-up runs before the start)
          </label>
          {scheduleEnabled && (
            <div className="row" style={{ gap: 10, alignItems: 'flex-end', marginTop: 8 }}>
              <div style={{ flex: 1 }}>
                <Field label="Start (UTC / Zulu)">
                  <ThemedInput type="datetime-local" value={startUtc} onChange={e => setStartUtc(e.target.value)} />
                </Field>
              </div>
              <div style={{ flex: 1, fontSize: 12, color: 'var(--fg-secondary)', paddingBottom: 8 }}>
                {parseZulu(startUtc)
                  ? <>Local: {new Date(parseZulu(startUtc) as number).toLocaleString()}</>
                  : 'Enter a UTC start time'}
              </div>
            </div>
          )}
        </Section>

        {capture.kind === 'scheduled' && (
          <div className="stack" style={{ gap: 6, padding: 12, border: '1px solid var(--border)', borderRadius: 'var(--radius)' }}>
            <div style={{ fontSize: 13 }}>
              Scheduled — warm-up starts in <strong>{fmtCountdown(capture.leadMs - now)}</strong>,
              capture at <strong>{new Date(capture.targetMs).toLocaleTimeString()}</strong> local.
            </div>
            <div><ThemedButton secondary onClick={cancelSchedule}>Cancel schedule</ThemedButton></div>
          </div>
        )}

        {capture.kind === 'running' && (
          <div className="stack" style={{ gap: 8 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
              <span>Capturing… {capture.recorded} aircraft · {capture.sectors} active sectors</span>
              <span style={{ color: 'var(--fg-secondary)', fontVariantNumeric: 'tabular-nums' }}>
                {Math.round(capture.elapsed)}/{capture.total}s
              </span>
            </div>
            <div style={{ width: '100%', height: 6, background: 'var(--bg-tertiary, #2a2a2a)', borderRadius: 3, overflow: 'hidden' }}>
              <div style={{ width: `${Math.max(2, pct)}%`, height: '100%', background: 'var(--accent, #3b82f6)', transition: 'width 0.4s ease' }} />
            </div>
            <div className="row" style={{ gap: 8 }}>
              <ThemedButton secondary onClick={endNow}>End Now</ThemedButton>
              <ThemedButton secondary onClick={openMap}>Open full ERAM ↗</ThemedButton>
            </div>
            <LiveScope
              facility={facility.trim().toUpperCase()}
              allSectors={allSectors}
              sectorList={allSectors ? [] : sector.split(',').map(s => s.trim()).filter(Boolean)}
            />
          </div>
        )}

        {capture.kind === 'error' && <p style={{ color: 'var(--error)' }}>Error: {capture.message}</p>}

        {capture.kind === 'done' && (
          <div className="stack" style={{ gap: 8, padding: 12, border: '1px solid var(--border)', borderRadius: 'var(--radius)' }}>
            <p style={{ margin: 0 }}>
              Captured <strong>{capture.result.recorded ?? 0}</strong> aircraft across{' '}
              <strong>{capture.result.diagnostics?.activeSectorCount ?? 0}</strong> active sectors.
            </p>
            {capture.result.diagnostics?.recordedBySector && (
              <div style={{ fontSize: 12, color: 'var(--fg-secondary)' }}>
                {Object.entries(capture.result.diagnostics.recordedBySector)
                  .map(([s, n]) => `${s}:${n}`)
                  .join('  ')}
              </div>
            )}
            {(capture.result.recorded ?? 0) === 0 && (
              <p style={{ color: 'var(--warning, #c77)', fontSize: 12, margin: 0 }}>
                No aircraft captured. Try a longer warm-up — routes accumulate as flights file/amend.
              </p>
            )}
            <Field label="Scenario name (optional — vNAS title)">
              <ThemedInput
                value={scenarioName}
                onChange={e => setScenarioName(e.target.value)}
                placeholder={`${facility.trim().toUpperCase()} Live Replay`}
              />
            </Field>
          </div>
        )}
      </div>

      <div className="row" style={{ marginTop: 16, gap: 8, justifyContent: 'space-between' }}>
        <ThemedButton secondary onClick={() => setScreen('type')}>← Back</ThemedButton>
        <div className="row" style={{ gap: 8 }}>
          <ThemedButton onClick={onStart} disabled={!canStart}>
            {scheduleEnabled ? 'Schedule Capture' : 'Start Capture'}
          </ThemedButton>
          {(() => {
            const ready = capture.kind === 'done' && !!capture.result.captureFile && (capture.result.recorded ?? 0) > 0;
            return (
              <>
                <ThemedButton onClick={proceedToEdit} disabled={!ready}>Edit Aircraft →</ThemedButton>
                <ThemedButton onClick={proceedToGenerate} disabled={!ready}>Generate →</ThemedButton>
              </>
            );
          })()}
        </div>
      </div>
    </Card>
  );
}
