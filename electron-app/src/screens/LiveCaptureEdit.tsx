import type React from 'react';
import { useEffect, useMemo, useState } from 'react';
import { useScenarioStore } from '../state/scenarioStore';
import { Card, Section, ThemedButton, ThemedInput } from '../components/Themed';
import type { CaptureFile, CaptureAircraft, SectorGeometry, VnasPosition } from '../../shared/types';

const W = 560;
const H = 340;
const PAD = 18;

function normSec(s: string): string {
  const t = (s || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase().replace(/^0+/, '');
  return t || '0';
}

export function LiveCaptureEdit() {
  const { config, update, setScreen } = useScenarioStore();
  const [cap, setCap] = useState<CaptureFile | null>(null);
  const [geom, setGeom] = useState<SectorGeometry[]>([]);
  const [positions, setPositions] = useState<VnasPosition[]>([]);
  const [routeSectors, setRouteSectors] = useState<Record<string, string[]>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  // selection tool state
  const [ownerSel, setOwnerSel] = useState<Set<string>>(new Set());
  const [routeSel, setRouteSel] = useState<Set<string>>(new Set());
  const [randomPct, setRandomPct] = useState(0);

  // ATC state — on by default: the goal is every track owned at load, so the
  // trainee signs on to one sector and vNAS ghosts auto-flash the rest.
  const [atcEnabled, setAtcEnabled] = useState(true);
  const [sectorToPosition, setSectorToPosition] = useState<Record<string, string>>({});
  const [fallbackPos, setFallbackPos] = useState('');
  const [handoffFromTimeline, setHandoffFromTimeline] = useState(true);
  // Positions the trainee works (no auto-handoff) — chosen after combining.
  const [traineePositions, setTraineePositions] = useState<Set<string>>(new Set());

  useEffect(() => {
    (async () => {
      if (!config.captureFile) { setLoading(false); return; }
      const c = await window.ssg.liveCapture.readCapture(config.captureFile);
      if (c) {
        c.aircraft = c.aircraft.map(a => ({ ...a, include: a.category !== 'vicinity' }));
        setCap(c);
        const fac = (c.facility || '').toUpperCase();
        const [g, p, rs] = await Promise.all([
          window.ssg.liveCapture.getSectorGeometry(fac),
          window.ssg.liveCapture.getPositions(fac),
          window.ssg.liveCapture.getRouteSectors(fac, config.captureFile),
        ]);
        if (g.status === 'ok' && g.sectors) setGeom(g.sectors);
        if (p.status === 'ok' && p.positions) {
          setPositions(p.positions);
          // default each active owning sector → the position whose sectorId matches
          const owners = Array.from(new Set(c.aircraft.map(a => (a.entry?.controllingSector || '').toUpperCase()).filter(Boolean)));
          const init: Record<string, string> = {};
          for (const o of owners) {
            const match = p.positions.find(pp => pp.sectorId && normSec(pp.sectorId) === normSec(o));
            init[o] = match ? match.id : '';
          }
          setSectorToPosition(init);
        }
        if (rs.status === 'ok' && rs.routeSectors) setRouteSectors(rs.routeSectors);
      }
      setLoading(false);
    })();
  }, [config.captureFile]);

  const aircraft = cap?.aircraft ?? [];
  const included = aircraft.filter(a => a.include);

  const activeOwners = useMemo(
    () => Array.from(new Set(aircraft.map(a => (a.entry?.controllingSector || '').toUpperCase()).filter(Boolean))).sort(),
    [aircraft],
  );
  const routeUniverse = useMemo(
    () => Array.from(new Set(Object.values(routeSectors).flat())).sort(),
    [routeSectors],
  );

  const setInclude = (pred: (a: CaptureAircraft) => boolean) =>
    setCap(c => (c ? { ...c, aircraft: c.aircraft.map(a => ({ ...a, include: pred(a) })) } : c));
  const setAll = (v: boolean) => setInclude(() => v);

  const includeOnlyOwners = () =>
    setInclude(a => ownerSel.has((a.entry?.controllingSector || '').toUpperCase()));
  const includeOnlyRoute = () =>
    setInclude(a => (routeSectors[a.gufi] || []).some(s => routeSel.has(s)));

  const removeRandom = () => {
    if (randomPct <= 0) return;
    setCap(c => {
      if (!c) return c;
      const inc = c.aircraft.filter(a => a.include);
      const n = Math.floor((inc.length * Math.min(100, randomPct)) / 100);
      const victims = new Set(
        [...inc].sort(() => Math.random() - 0.5).slice(0, n).map(a => a.gufi),
      );
      return { ...c, aircraft: c.aircraft.map(a => (victims.has(a.gufi) ? { ...a, include: false } : a)) };
    });
  };

  const toggle = (set: Set<string>, setSet: (s: Set<string>) => void, v: string) => {
    const next = new Set(set);
    next.has(v) ? next.delete(v) : next.add(v);
    setSet(next);
  };

  const setAc = (i: number, patch: Partial<CaptureAircraft>) =>
    setCap(c => (c ? { ...c, aircraft: c.aircraft.map((a, j) => (j === i ? { ...a, ...patch } : a)) } : c));
  const setFp = (i: number, patch: Partial<CaptureAircraft['flightplan']>) =>
    setCap(c => (c ? { ...c, aircraft: c.aircraft.map((a, j) => (j === i ? { ...a, flightplan: { ...a.flightplan, ...patch } } : a)) } : c));

  const generate = async () => {
    if (!cap) return;
    setSaving(true);
    try {
      const edited: CaptureFile = { ...cap, aircraft: included };
      if (atcEnabled) {
        const map: Record<string, string> = {};
        for (const [s, p] of Object.entries(sectorToPosition)) if (p) map[s] = p;
        edited.atcConfig = {
          enabled: true,
          sectorToPosition: map,
          fallbackPositionId: fallbackPos || null,
          handoffFromTimeline,
          traineePositionIds: Array.from(traineePositions),
        };
      }
      const path = await window.ssg.liveCapture.writeCapture(edited);
      update({ captureFile: path });
      setScreen('generation');
    } finally {
      setSaving(false);
    }
  };

  // ── scope ──
  const box = useMemo(() => {
    let mnLon = Infinity, mnLat = Infinity, mxLon = -Infinity, mxLat = -Infinity;
    for (const s of geom) for (const ring of s.rings) for (const [lon, lat] of ring) {
      mnLon = Math.min(mnLon, lon); mxLon = Math.max(mxLon, lon);
      mnLat = Math.min(mnLat, lat); mxLat = Math.max(mxLat, lat);
    }
    return Number.isFinite(mnLon) ? { mnLon, mnLat, mxLon, mxLat } : null;
  }, [geom]);
  const project = (lon: number, lat: number): [number, number] => {
    if (!box) return [0, 0];
    const midLat = (box.mnLat + box.mxLat) / 2;
    const lonScale = Math.cos((midLat * Math.PI) / 180) || 1;
    const spanLon = (box.mxLon - box.mnLon) * lonScale || 1;
    const spanLat = box.mxLat - box.mnLat || 1;
    const scale = Math.min((W - 2 * PAD) / spanLon, (H - 2 * PAD) / spanLat);
    return [PAD + (lon - box.mnLon) * lonScale * scale, PAD + (box.mxLat - lat) * scale];
  };

  if (loading) return <Card title="Edit Capture"><p>Loading capture…</p></Card>;
  if (!cap) return (
    <Card title="Edit Capture">
      <p style={{ color: 'var(--error)' }}>Could not load the capture file.</p>
      <ThemedButton secondary onClick={() => setScreen('capture')}>← Back</ThemedButton>
    </Card>
  );

  const cell: React.CSSProperties = { padding: '2px 4px', borderBottom: '1px solid var(--border)' };
  const chip = (active: boolean): React.CSSProperties => ({
    fontSize: 11, padding: '2px 7px', borderRadius: 10, cursor: 'pointer',
    border: '1px solid var(--border)',
    background: active ? 'var(--accent, #3b82f6)' : 'transparent',
    color: active ? '#fff' : 'var(--fg-secondary)',
  });
  const posLabel = (p: VnasPosition) => `${p.callsign ?? ''} ${p.name ?? ''}`.trim() + (p.sectorId ? ` [${p.sectorId}]` : '');
  const sortedPositions = [...positions].sort((a, b) => (a.sectorId ? 0 : 1) - (b.sectorId ? 0 : 1));
  // How many INCLUDED aircraft would get an owning position (mapped or fallback).
  const ownedCount = included.filter(
    a => !!(sectorToPosition[(a.entry?.controllingSector || '').toUpperCase()] || fallbackPos),
  ).length;
  // Distinct positions actually in use (combined) — the set you pick trainee from.
  const usedPosIds = Array.from(new Set([
    ...Object.values(sectorToPosition).filter(Boolean),
    ...((Object.values(sectorToPosition).some(v => !v) && fallbackPos) ? [fallbackPos] : []),
  ]));
  const posById = (id: string) => positions.find(p => p.id === id);
  // Resolved owning position for an aircraft, given the current combine mapping.
  const ownerOf = (a: CaptureAircraft): { label: string; trainee: boolean } => {
    if (!atcEnabled) return { label: '—', trainee: false };
    const sec = (a.entry?.controllingSector || '').toUpperCase();
    const pid = sectorToPosition[sec] || fallbackPos;
    if (!pid) return { label: '(unowned)', trainee: false };
    const p = posById(pid);
    return { label: p ? (p.callsign || p.name || pid) : pid, trainee: traineePositions.has(pid) };
  };
  // Resolved handoff behavior for the scenario, given the current ATC config.
  const handoffStatusOf = (a: CaptureAircraft): string => {
    if (!atcEnabled) return '—';
    if (ownerOf(a).trainee) return 'manual';
    const hos = a.handoffs || [];
    if (!handoffFromTimeline || hos.length === 0) return 'auto';
    const first = hos[0];
    const delay = Math.max(0, (first.atOffsetSec ?? 0) - a.firstSeenOffsetSec);
    const tgt = `${first.toFacility || ''}${first.toSector ? '/' + first.toSector : ''}`;
    return `→${tgt || '?'} @${delay}s`;
  };

  return (
    <Card title={`Edit Capture — ${cap.facility ?? ''} (${included.length}/${aircraft.length} included)`}>
      {/* 1. combine sectors → positions (foundational, first) */}
      <Section title="1. Positions — combine sectors">
        <label className="row" style={{ gap: 8, alignItems: 'center', fontSize: 13 }}>
          <input type="checkbox" checked={atcEnabled} onChange={e => setAtcEnabled(e.target.checked)} />
          Assign aircraft to vNAS positions ({positions.length} available)
        </label>
        {atcEnabled && (
          <div className="stack" style={{ gap: 6, marginTop: 6 }}>
            <div style={{ fontSize: 12, color: ownedCount === included.length ? 'var(--success, #6c6)' : 'var(--warning, #c77)' }}>
              {ownedCount === included.length
                ? `✓ All ${included.length} tracks will be owned at load`
                : `${ownedCount}/${included.length} tracks owned — set a fallback so the rest aren't untracked`}
            </div>
            <label className="row" style={{ gap: 8, alignItems: 'center', fontSize: 12 }}>
              Fallback (unmatched sectors):
              <select value={fallbackPos} onChange={e => setFallbackPos(e.target.value)} className="themed">
                <option value="">(none)</option>
                {sortedPositions.map(p => <option key={p.id} value={p.id}>{posLabel(p)}</option>)}
              </select>
            </label>
            <div style={{ maxHeight: 150, overflow: 'auto', fontSize: 12 }}>
              {activeOwners.map(o => (
                <div key={o} className="row" style={{ gap: 8, alignItems: 'center', marginBottom: 3 }}>
                  <span style={{ width: 48, fontFamily: 'monospace' }}>{o}</span>
                  <span style={{ color: 'var(--fg-secondary)' }}>→</span>
                  <select className="themed" value={sectorToPosition[o] ?? ''}
                    onChange={e => setSectorToPosition(m => ({ ...m, [o]: e.target.value }))}>
                    <option value="">(use fallback)</option>
                    {sortedPositions.map(p => <option key={p.id} value={p.id}>{posLabel(p)}</option>)}
                  </select>
                </div>
              ))}
            </div>
            <p style={{ fontSize: 11, color: 'var(--fg-secondary)', margin: 0 }}>
              Combine by pointing multiple sectors at the same position (e.g. all 09 → 12). This applies first; everything below uses the combined positions.
            </p>
          </div>
        )}
      </Section>

      {/* 2. trainee position(s) */}
      {atcEnabled && usedPosIds.length > 0 && (
        <Section title="2. Trainee position(s) — you work these">
          <div className="row" style={{ gap: 5, flexWrap: 'wrap' }}>
            {usedPosIds.map(id => {
              const p = posById(id);
              const label = p ? (p.callsign || p.name || id) : id;
              return (
                <span key={id} style={chip(traineePositions.has(id))}
                  onClick={() => toggle(traineePositions, setTraineePositions, id)}>{label}</span>
              );
            })}
          </div>
          <label className="row" style={{ gap: 8, alignItems: 'center', fontSize: 12, marginTop: 6 }}>
            <input type="checkbox" checked={handoffFromTimeline} onChange={e => setHandoffFromTimeline(e.target.checked)} />
            Auto-handoff timing from captured handoffs (for non-trainee positions)
          </label>
          <p style={{ fontSize: 11, color: 'var(--fg-secondary)', margin: '4px 0 0' }}>
            Auto-handoff (in & out) is disabled for the trainee position(s) — you do your own. Capture data is preserved, so the same capture can target other sectors later.
          </p>
        </Section>
      )}

      {/* 3. selection tools */}
      <Section title="3. Select aircraft">
        <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <ThemedButton secondary onClick={() => setAll(true)}>Include all</ThemedButton>
          <ThemedButton secondary onClick={() => setAll(false)}>Include none</ThemedButton>
          <span style={{ marginLeft: 8 }}>
            <ThemedInput type="number" min={0} max={100} style={{ width: 56 }} value={randomPct}
              onChange={e => setRandomPct(Number(e.target.value) || 0)} /> %
            <ThemedButton secondary onClick={removeRandom} style={{ marginLeft: 6 }}>Remove random</ThemedButton>
          </span>
        </div>
        {activeOwners.length > 0 && (
          <div style={{ marginTop: 8 }}>
            <div style={{ fontSize: 12, color: 'var(--fg-secondary)', marginBottom: 4 }}>By owning sector:</div>
            <div className="row" style={{ gap: 5, flexWrap: 'wrap' }}>
              {activeOwners.map(o => (
                <span key={o} style={chip(ownerSel.has(o))} onClick={() => toggle(ownerSel, setOwnerSel, o)}>{o}</span>
              ))}
              <ThemedButton secondary onClick={includeOnlyOwners} disabled={ownerSel.size === 0}>Include only these</ThemedButton>
            </div>
          </div>
        )}
        {routeUniverse.length > 0 && (
          <div style={{ marginTop: 8 }}>
            <div style={{ fontSize: 12, color: 'var(--fg-secondary)', marginBottom: 4 }}>By route-through sector:</div>
            <div className="row" style={{ gap: 5, flexWrap: 'wrap' }}>
              {routeUniverse.map(o => (
                <span key={o} style={chip(routeSel.has(o))} onClick={() => toggle(routeSel, setRouteSel, o)}>{o}</span>
              ))}
              <ThemedButton secondary onClick={includeOnlyRoute} disabled={routeSel.size === 0}>Include only these</ThemedButton>
            </div>
          </div>
        )}
      </Section>

      {/* scope */}
      <svg width="100%" viewBox={`0 0 ${W} ${H}`}
        style={{ background: '#0b0f14', border: '1px solid var(--border)', borderRadius: 'var(--radius)', margin: '10px 0' }}>
        {geom.map((s, si) => s.rings.map((ring, ri) => (
          <polyline key={`${si}-${ri}`} points={ring.map(([lon, lat]) => project(lon, lat).join(',')).join(' ')}
            fill="none" stroke="#2e7d32" strokeWidth={1} opacity={0.7} />
        )))}
        {box && aircraft.map(a => {
          if (a.spawn.lat == null || a.spawn.lon == null) return null;
          const [x, y] = project(a.spawn.lon, a.spawn.lat);
          const color = !a.include ? '#52606d' : a.category === 'vicinity' ? '#7aa2ff' : '#39ff88';
          return (
            <g key={a.gufi}>
              <circle cx={x} cy={y} r={a.include ? 3 : 2} fill={color} />
              {a.include && <text x={x + 5} y={y + 3} fill={color} fontSize={8} fontFamily="monospace">{a.callsign}</text>}
            </g>
          );
        })}
      </svg>

      {/* table */}
      <div style={{ maxHeight: 260, overflow: 'auto' }}>
        <table style={{ width: '100%', fontSize: 11, borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ textAlign: 'left', color: 'var(--fg-secondary)' }}>
              <th style={cell}></th><th style={cell}>Callsign</th><th style={cell}>Type</th>
              <th style={cell}>Dep→Dest</th><th style={cell}>Alt</th><th style={cell}>Spawn(s)</th>
              <th style={cell}>Sec</th><th style={cell}>Owner</th><th style={cell}>Handoff</th><th style={cell}>Route</th>
            </tr>
          </thead>
          <tbody>
            {aircraft.map((a, i) => (
              <tr key={a.gufi} style={{ opacity: a.include ? 1 : 0.5 }}>
                <td style={cell}><input type="checkbox" checked={!!a.include} onChange={e => setAc(i, { include: e.target.checked })} /></td>
                <td style={cell}><ThemedInput style={{ width: 78 }} value={a.callsign} onChange={e => setAc(i, { callsign: e.target.value })} /></td>
                <td style={cell}><ThemedInput style={{ width: 56, color: a.aircraftType ? undefined : 'var(--warning, #c77)' }}
                  value={a.aircraftType ?? ''} placeholder="set" onChange={e => setAc(i, { aircraftType: e.target.value })} /></td>
                <td style={{ ...cell, whiteSpace: 'nowrap', color: 'var(--fg-secondary)' }}>{(a.flightplan.departure ?? '?')}→{(a.flightplan.destination ?? '?')}</td>
                <td style={cell}><ThemedInput type="number" style={{ width: 64 }} value={a.flightplan.cruiseAltitudeFt ?? ''}
                  onChange={e => setFp(i, { cruiseAltitudeFt: Number(e.target.value) || null })} /></td>
                <td style={cell}><ThemedInput type="number" style={{ width: 54 }} value={a.firstSeenOffsetSec}
                  onChange={e => setAc(i, { firstSeenOffsetSec: Math.max(0, Number(e.target.value) || 0) })} /></td>
                <td style={{ ...cell, color: 'var(--fg-secondary)' }}>{a.entry?.controllingSector ?? ''}</td>
                {(() => { const o = ownerOf(a); return (
                  <td style={{ ...cell, whiteSpace: 'nowrap', color: o.trainee ? 'var(--accent, #3b82f6)' : 'var(--fg-secondary)' }}>
                    {o.label}{o.trainee ? ' ★' : ''}
                  </td>
                ); })()}
                <td style={{ ...cell, whiteSpace: 'nowrap', color: 'var(--fg-secondary)' }}>{handoffStatusOf(a)}</td>
                <td style={cell}><ThemedInput style={{ width: 200 }} value={a.flightplan.route ?? ''} onChange={e => setFp(i, { route: e.target.value })} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="row" style={{ marginTop: 14, gap: 8, justifyContent: 'space-between' }}>
        <ThemedButton secondary onClick={() => setScreen('capture')}>← Back</ThemedButton>
        <ThemedButton onClick={generate} disabled={saving || included.length === 0}>
          {saving ? 'Preparing…' : `Generate ${included.length} →`}
        </ThemedButton>
      </div>
    </Card>
  );
}
