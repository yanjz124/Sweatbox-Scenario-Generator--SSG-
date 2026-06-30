import type React from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useScenarioStore } from '../state/scenarioStore';
import { Card, Section, ThemedButton, ThemedInput } from '../components/Themed';
import type { CaptureFile, CaptureAircraft, SectorGeometry, VnasPosition } from '../../shared/types';

const W = 560;
const H = 320;
const PAD = 18;

function normSec(s: string): string {
  const t = (s || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase().replace(/^0+/, '');
  return t || '0';
}
/** Ownership identity: FACILITY/SECTOR (a bare sector isn't unique across
 *  ZDC / a neighbor ARTCC / a TRACON). */
function ownerKey(a: CaptureAircraft): string {
  const f = (a.entry?.controllingFacility || '').toUpperCase();
  const s = (a.entry?.controllingSector || '').toUpperCase();
  return f || s ? `${f}/${s}` : '';
}

export function LiveCaptureEdit() {
  const { config, update, setScreen } = useScenarioStore();
  const [cap, setCap] = useState<CaptureFile | null>(null);
  const [geom, setGeom] = useState<SectorGeometry[]>([]);
  const [positions, setPositions] = useState<VnasPosition[]>([]);
  const [routeSectors, setRouteSectors] = useState<Record<string, string[]>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const [ownerSel, setOwnerSel] = useState<Set<string>>(new Set());
  const [routeSel, setRouteSel] = useState<Set<string>>(new Set());
  const [randomPct, setRandomPct] = useState(0);

  const [atcEnabled, setAtcEnabled] = useState(true);
  // key = ownerKey ("FAC/SEC") -> vNAS position id
  const [ownerToPosition, setOwnerToPosition] = useState<Record<string, string>>({});
  const [fallbackPos, setFallbackPos] = useState('');
  const [handoffFromTimeline, setHandoffFromTimeline] = useState(true);
  const [traineePositions, setTraineePositions] = useState<Set<string>>(new Set());
  const [posError, setPosError] = useState<string | null>(null);
  const [posLoading, setPosLoading] = useState(false);

  // Positions need the network (data-api); the other two are local. Load it on
  // its own so a transient fetch failure never silently blanks the picker —
  // surface the error + offer a retry, keeping the rest of the editor usable.
  const loadPositions = async (c: CaptureFile) => {
    setPosLoading(true);
    setPosError(null);
    try {
      const fac = (c.facility || '').toUpperCase();
      const p = await window.ssg.liveCapture.getPositions(fac);
      if (p.status === 'ok' && p.positions && p.positions.length > 0) {
        setPositions(p.positions);
        // auto-match + default fallback run reactively once positions land.
      } else {
        setPosError(p.message || `No positions returned for ${fac} (status: ${p.status}).`);
      }
    } catch (e) {
      setPosError(String(e));
    } finally {
      setPosLoading(false);
    }
  };

  useEffect(() => {
    (async () => {
      if (!config.captureFile) { setLoading(false); return; }
      const c = await window.ssg.liveCapture.readCapture(config.captureFile);
      if (c) {
        // Include everything by default now — geofenced neighbor traffic spawns
        // owned by its own (neighbor) position and gets handed to us in flow.
        c.aircraft = c.aircraft.map(a => ({ ...a, include: true }));
        setCap(c);
        const fac = (c.facility || '').toUpperCase();
        // Local calls (no network) — independent of the positions fetch.
        window.ssg.liveCapture.getSectorGeometry(fac)
          .then(g => { if (g.status === 'ok' && g.sectors) setGeom(g.sectors); }).catch(() => {});
        window.ssg.liveCapture.getRouteSectors(fac, config.captureFile)
          .then(rs => { if (rs.status === 'ok' && rs.routeSectors) setRouteSectors(rs.routeSectors); }).catch(() => {});
        await loadPositions(c);
      }
      setLoading(false);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config.captureFile]);

  const aircraft = cap?.aircraft ?? [];
  const included = aircraft.filter(a => a.include);

  const countByOwner = useMemo(() => {
    const m = new Map<string, number>();
    for (const a of aircraft) {
      const k = ownerKey(a);
      if (k) m.set(k, (m.get(k) || 0) + 1);
    }
    return m;
  }, [aircraft]);
  const activeOwners = useMemo(
    () => Array.from(countByOwner.keys()).sort((a, b) => (countByOwner.get(b) || 0) - (countByOwner.get(a) || 0)),
    [countByOwner],
  );
  const routeUniverse = useMemo(() => Array.from(new Set(Object.values(routeSectors).flat())).sort(), [routeSectors]);

  // Auto-match owners → positions whenever the (full) position set lands. Runs
  // reactively so it covers the case where positions arrive/refresh after the
  // first render (e.g. neighbor ARTCCs loading a beat later). Only fills owners
  // that aren't already mapped, so manual choices are preserved.
  useEffect(() => {
    if (positions.length === 0 || activeOwners.length === 0) return;
    setOwnerToPosition(prev => {
      const next: Record<string, string> = { ...prev };
      let changed = false;
      for (const k of activeOwners) {
        if (next[k]) continue;
        const [f, s] = k.split('/');
        const m = positions.find(pp => pp.artcc === f && pp.sectorId && normSec(pp.sectorId) === normSec(s));
        const id = m ? m.id : '';
        if (next[k] !== id) { next[k] = id; changed = true; }
      }
      return changed ? next : prev;
    });
  }, [positions, activeOwners]);

  // Default the fallback to the busiest owner's mapped position (top of the
  // owner list) so any owner that can't be matched (TRACON / unloaded ARTCC)
  // still has a real working position to flash to — no track loads unowned.
  useEffect(() => {
    if (fallbackPos || positions.length === 0) return;
    for (const k of activeOwners) {
      const pid = ownerToPosition[k];
      if (pid) { setFallbackPos(pid); break; }
    }
  }, [positions, activeOwners, ownerToPosition, fallbackPos]);

  // ── position picker: one shared datalist for all 1000+ positions (efficient
  // + searchable). label is unique so we can resolve label → id. ──
  const labelToId = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of positions) {
      let l = `${p.callsign || p.name || p.id} — ${p.facility ?? ''}${p.sectorId ? ` [${p.sectorId}]` : ''}`;
      while (m.has(l)) l += ' ·';
      m.set(l, p.id);
    }
    return m;
  }, [positions]);
  const idToLabel = useMemo(() => {
    const m = new Map<string, string>();
    for (const [l, id] of labelToId) m.set(id, l);
    return m;
  }, [labelToId]);
  const posById = (id: string) => positions.find(p => p.id === id);
  const artccCount = useMemo(() => new Set(positions.map(p => p.artcc).filter(Boolean)).size, [positions]);
  const posLabel = (id: string) => {
    const p = posById(id);
    return p ? `${p.callsign || p.name || id}${p.facility ? ` — ${p.facility}` : ''}` : id;
  };
  // Positions in active use (what a fallback should pick from) — the working
  // sectors owners are mapped to, plus the current fallback.
  const mappedPositions = useMemo(() => {
    const s = new Set(Object.values(ownerToPosition).filter(Boolean));
    if (fallbackPos) s.add(fallbackPos);
    return Array.from(s).sort((a, b) => posLabel(a).localeCompare(posLabel(b)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ownerToPosition, fallbackPos, positions]);

  const setInclude = (pred: (a: CaptureAircraft) => boolean) =>
    setCap(c => (c ? { ...c, aircraft: c.aircraft.map(a => ({ ...a, include: pred(a) })) } : c));
  const setAll = (v: boolean) => setInclude(() => v);
  const includeOnlyOwners = () => setInclude(a => ownerSel.has(ownerKey(a)));
  const includeOnlyRoute = () => setInclude(a => (routeSectors[a.gufi] || []).some(s => routeSel.has(s)));
  const removeRandom = () => {
    if (randomPct <= 0) return;
    setCap(c => {
      if (!c) return c;
      const inc = c.aircraft.filter(a => a.include);
      const n = Math.floor((inc.length * Math.min(100, randomPct)) / 100);
      const victims = new Set([...inc].sort(() => Math.random() - 0.5).slice(0, n).map(a => a.gufi));
      return { ...c, aircraft: c.aircraft.map(a => (victims.has(a.gufi) ? { ...a, include: false } : a)) };
    });
  };

  // ── "touches our airspace" filter — drop traffic that never enters the
  // captured facility/sectors so we don't spam vNAS with irrelevant aircraft. ──
  const ourFac = (cap?.facility || '').toUpperCase();
  const facilityWide = useMemo(() => {
    const s = (cap?.sector || '').trim().toUpperCase();
    return s === '' || s === 'ALL';
  }, [cap?.sector]);
  const ourSectorSet = useMemo(
    () => new Set((cap?.sector || '').split(',').map(s => normSec(s)).filter(Boolean)),
    [cap?.sector],
  );
  const isOurSector = (sec: string) => facilityWide || ourSectorSet.has(normSec(sec));
  const touchesOurAirspace = (a: CaptureAircraft): boolean => {
    // Owned by one of our sectors at capture time.
    if ((a.entry?.controllingFacility || '').toUpperCase() === ourFac && isOurSector(a.entry?.controllingSector || '')) return true;
    // Handed off to/from us during the window.
    for (const h of (a.handoffs || [])) {
      if ((h.toFacility || '').toUpperCase() === ourFac && isOurSector(h.toSector || '')) return true;
      if ((h.fromFacility || '').toUpperCase() === ourFac && isOurSector(h.fromSector || '')) return true;
    }
    // Filed route crosses our sectors (KML route-through; getRouteSectors only
    // returns sectors in OUR facility, so any hit means it transits us).
    const rs = routeSectors[a.gufi] || [];
    if (rs.length && (facilityWide || rs.some(s => ourSectorSet.has(normSec(s))))) return true;
    return false;
  };
  const removeNonTouching = () =>
    setCap(c => (c ? { ...c, aircraft: c.aircraft.map(a => ({ ...a, include: a.include && touchesOurAirspace(a) })) } : c));

  // Auto-apply once route data lands (the default: only keep aircraft that
  // actually enter our airspace). Runs a single time; manual edits afterward win.
  const autoFilteredRef = useRef(false);
  useEffect(() => {
    if (autoFilteredRef.current || !cap || Object.keys(routeSectors).length === 0) return;
    autoFilteredRef.current = true;
    setInclude(touchesOurAirspace);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeSectors, cap]);
  const toggle = (set: Set<string>, setSet: (s: Set<string>) => void, v: string) => {
    const next = new Set(set);
    next.has(v) ? next.delete(v) : next.add(v);
    setSet(next);
  };
  const setAc = (i: number, patch: Partial<CaptureAircraft>) =>
    setCap(c => (c ? { ...c, aircraft: c.aircraft.map((a, j) => (j === i ? { ...a, ...patch } : a)) } : c));
  const setFp = (i: number, patch: Partial<CaptureAircraft['flightplan']>) =>
    setCap(c => (c ? { ...c, aircraft: c.aircraft.map((a, j) => (j === i ? { ...a, flightplan: { ...a.flightplan, ...patch } } : a)) } : c));

  const ownerOf = (a: CaptureAircraft): { label: string; trainee: boolean } => {
    if (!atcEnabled) return { label: '—', trainee: false };
    const pid = ownerToPosition[ownerKey(a)] || fallbackPos;
    if (!pid) return { label: '(unowned)', trainee: false };
    const p = posById(pid);
    return { label: p ? (p.callsign || p.name || pid) : pid, trainee: traineePositions.has(pid) };
  };
  const ownedCount = included.filter(a => !!(ownerToPosition[ownerKey(a)] || fallbackPos)).length;
  const usedPosIds = Array.from(new Set([
    ...Object.values(ownerToPosition).filter(Boolean),
    ...((Object.keys(ownerToPosition).length && fallbackPos) ? [fallbackPos] : []),
  ]));
  const rosterCount = usedPosIds.length;

  const generate = async () => {
    if (!cap) return;
    setSaving(true);
    try {
      const edited: CaptureFile = { ...cap, aircraft: included };
      if (atcEnabled) {
        const map: Record<string, string> = {};
        for (const [k, p] of Object.entries(ownerToPosition)) if (p) map[k] = p;
        // Metadata (facilityId/artccId) for every used position — trainee seats
        // INCLUDED, so their tracks are owned at load too. The generator derives
        // the actual roster from real aircraft assignments using this lookup.
        const atcEntries = usedPosIds.map(id => {
          const p = posById(id);
          return {
            positionId: id,
            facilityId: p?.facilityId || p?.artcc || cap.facility || '',
            artccId: p?.artcc || cap.facility || '',
          };
        });
        edited.atcConfig = {
          enabled: true,
          sectorToPosition: map,
          fallbackPositionId: fallbackPos || null,
          handoffFromTimeline,
          traineePositionIds: Array.from(traineePositions),
          atcEntries,
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

  return (
    <Card title={`Edit Capture — ${cap.facility ?? ''} (${included.length}/${aircraft.length} included)`}>
      {/* shared position datalist (rendered once) */}
      <datalist id="ssg-positions">
        {Array.from(labelToId.keys()).map(l => <option key={l} value={l} />)}
      </datalist>

      {/* 1. combine owners → positions */}
      <Section title="1. Positions — combine sectors">
        <label className="row" style={{ gap: 8, alignItems: 'center', fontSize: 13 }}>
          <input type="checkbox" checked={atcEnabled} onChange={e => setAtcEnabled(e.target.checked)} />
          Assign aircraft to vNAS positions ({posLoading ? 'loading…' : `${positions.length} available · ${artccCount} ARTCC${artccCount === 1 ? '' : 's'}`})
        </label>
        {(posError || (!posLoading && positions.length === 0)) && (
          <div className="row" style={{ gap: 8, alignItems: 'center', marginTop: 6, fontSize: 12, color: 'var(--error)' }}>
            <span>{posError ? `Couldn't load positions: ${posError}` : 'No positions loaded (network/data-api).'}</span>
            <ThemedButton secondary onClick={() => cap && loadPositions(cap)} disabled={posLoading}>
              {posLoading ? 'Retrying…' : 'Reload positions'}
            </ThemedButton>
          </div>
        )}
        {atcEnabled && (
          <div className="stack" style={{ gap: 6, marginTop: 6 }}>
            <div style={{ fontSize: 12, color: ownedCount === included.length ? 'var(--success, #6c6)' : 'var(--warning, #c77)' }}>
              {ownedCount === included.length
                ? `✓ All ${included.length} tracks will be owned at load`
                : `${ownedCount}/${included.length} tracks owned — set a fallback or map the rest`}
            </div>
            <label className="row" style={{ gap: 8, alignItems: 'center', fontSize: 12 }}>
              Fallback (unmatched owners):
              <select className="themed" style={{ minWidth: 240 }}
                value={fallbackPos} onChange={e => setFallbackPos(e.target.value)}>
                <option value="">(none — leave unowned)</option>
                {mappedPositions.map(id => (
                  <option key={id} value={id}>{posLabel(id)}</option>
                ))}
              </select>
              <span style={{ color: 'var(--fg-secondary)' }}>or</span>
              <input list="ssg-positions" className="themed" style={{ minWidth: 200 }}
                value="" placeholder="search any position…"
                onChange={e => { const id = labelToId.get(e.target.value); if (id) setFallbackPos(id); }} />
            </label>
            <div style={{ maxHeight: 160, overflow: 'auto', fontSize: 12 }}>
              {activeOwners.map(k => (
                <div key={k} className="row" style={{ gap: 8, alignItems: 'center', marginBottom: 3 }}>
                  <span style={{ width: 96, fontFamily: 'monospace' }}>
                    {k} <span style={{ color: 'var(--fg-secondary)' }}>({countByOwner.get(k) || 0})</span>
                  </span>
                  <span style={{ color: 'var(--fg-secondary)' }}>→</span>
                  <input list="ssg-positions" className="themed" style={{ minWidth: 240 }}
                    value={idToLabel.get(ownerToPosition[k]) ?? ''} placeholder="(use fallback)"
                    onFocus={e => e.currentTarget.select()}
                    onChange={e => {
                      const id = labelToId.get(e.target.value) || '';
                      setOwnerToPosition(m => ({ ...m, [k]: id }));
                    }} />
                </div>
              ))}
            </div>
            <p style={{ fontSize: 11, color: 'var(--fg-secondary)', margin: 0 }}>
              Owner is FACILITY/SECTOR (ZDC, neighbor ARTCCs, and TRACONs). Type to search positions;
              point several owners at the same position to combine. ARTCC sectors auto-match; TRACONs are manual.
            </p>
          </div>
        )}
      </Section>

      {/* 2. trainee positions */}
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
            Auto-handoff timing from captured handoffs (non-trainee positions)
          </label>
          <p style={{ fontSize: 11, color: 'var(--fg-secondary)', margin: '4px 0 0' }}>
            Auto-handoff (in & out) is disabled for the trainee position(s) — you do your own. Capture data is preserved.
          </p>
        </Section>
      )}

      {/* 3. selection */}
      <Section title="3. Select aircraft">
        <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <ThemedButton secondary onClick={() => setAll(true)}>Include all</ThemedButton>
          <ThemedButton secondary onClick={() => setAll(false)}>Include none</ThemedButton>
          <ThemedButton secondary onClick={removeNonTouching}>Remove not entering {ourFac}</ThemedButton>
          <span style={{ marginLeft: 8 }}>
            <ThemedInput type="number" min={0} max={100} style={{ width: 56 }} value={randomPct}
              onChange={e => setRandomPct(Number(e.target.value) || 0)} /> %
            <ThemedButton secondary onClick={removeRandom} style={{ marginLeft: 6 }}>Remove random</ThemedButton>
          </span>
        </div>
        {activeOwners.length > 0 && (
          <div style={{ marginTop: 8 }}>
            <div style={{ fontSize: 12, color: 'var(--fg-secondary)', marginBottom: 4 }}>By owner (FAC/SEC):</div>
            <div className="row" style={{ gap: 5, flexWrap: 'wrap' }}>
              {activeOwners.map(k => (
                <span key={k} style={chip(ownerSel.has(k))} onClick={() => toggle(ownerSel, setOwnerSel, k)}>
                  {k} ({countByOwner.get(k) || 0})
                </span>
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
      <div style={{ maxHeight: 240, overflow: 'auto' }}>
        <table style={{ width: '100%', fontSize: 11, borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ textAlign: 'left', color: 'var(--fg-secondary)' }}>
              <th style={cell}></th><th style={cell}>Callsign</th><th style={cell}>Type</th>
              <th style={cell}>Dep→Dest</th><th style={cell}>Alt</th><th style={cell}>Spawn(s)</th>
              <th style={cell}>Owns</th><th style={cell}>Pos</th><th style={cell}>Route</th>
            </tr>
          </thead>
          <tbody>
            {aircraft.map((a, i) => {
              const o = ownerOf(a);
              return (
                <tr key={a.gufi} style={{ opacity: a.include ? 1 : 0.5 }}>
                  <td style={cell}><input type="checkbox" checked={!!a.include} onChange={e => setAc(i, { include: e.target.checked })} /></td>
                  <td style={cell}><ThemedInput style={{ width: 78 }} value={a.callsign} onChange={e => setAc(i, { callsign: e.target.value })} /></td>
                  <td style={cell}><ThemedInput style={{ width: 54, color: a.aircraftType ? undefined : 'var(--warning, #c77)' }}
                    value={a.aircraftType ?? ''} placeholder="set" onChange={e => setAc(i, { aircraftType: e.target.value })} /></td>
                  <td style={{ ...cell, whiteSpace: 'nowrap', color: 'var(--fg-secondary)' }}>{(a.flightplan.departure ?? '?')}→{(a.flightplan.destination ?? '?')}</td>
                  <td style={cell}><ThemedInput type="number" style={{ width: 60 }} value={a.flightplan.cruiseAltitudeFt ?? ''}
                    onChange={e => setFp(i, { cruiseAltitudeFt: Number(e.target.value) || null })} /></td>
                  <td style={cell}><ThemedInput type="number" style={{ width: 50 }} value={a.firstSeenOffsetSec}
                    onChange={e => setAc(i, { firstSeenOffsetSec: Math.max(0, Number(e.target.value) || 0) })} /></td>
                  <td style={{ ...cell, color: 'var(--fg-secondary)', whiteSpace: 'nowrap' }}>{ownerKey(a)}</td>
                  <td style={{ ...cell, whiteSpace: 'nowrap', color: o.trainee ? 'var(--accent, #3b82f6)' : 'var(--fg-secondary)' }}>{o.label}{o.trainee ? ' ★' : ''}</td>
                  <td style={cell}><ThemedInput style={{ width: 200 }} value={a.flightplan.route ?? ''} onChange={e => setFp(i, { route: e.target.value })} /></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {atcEnabled && (
        <div style={{ marginTop: 12, fontSize: 12, color: rosterCount > 0 ? 'var(--success, #6c6)' : 'var(--warning, #c77)' }}>
          {rosterCount > 0
            ? `Will spawn ${rosterCount} pseudo-ATC position${rosterCount === 1 ? '' : 's'} (every track owned at load)`
            : 'No pseudo-ATC positions — map owners to positions above, or tracks will load unowned'}
          {traineePositions.size > 0 ? ` · ${traineePositions.size} trainee seat(s) — handed to you on connect` : ' · no trainee seat selected'}
        </div>
      )}
      <div className="row" style={{ marginTop: 8, gap: 8, justifyContent: 'space-between' }}>
        <ThemedButton secondary onClick={() => setScreen('capture')}>← Back</ThemedButton>
        <ThemedButton onClick={generate} disabled={saving || included.length === 0}>
          {saving ? 'Preparing…' : `Generate ${included.length} →`}
        </ThemedButton>
      </div>
    </Card>
  );
}
