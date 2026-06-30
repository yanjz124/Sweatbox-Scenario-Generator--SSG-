import type React from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useScenarioStore } from '../state/scenarioStore';
import { Card, Section, ThemedButton, ThemedInput } from '../components/Themed';
import { useSvgPanZoom } from '../hooks/useSvgPanZoom';
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
  const [facilityAirports, setFacilityAirports] = useState<Record<string, string[]>>({});
  const [routeSectors, setRouteSectors] = useState<Record<string, string[]>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const [ownerSel, setOwnerSel] = useState<Set<string>>(new Set());
  const [routeSel, setRouteSel] = useState<Set<string>>(new Set());
  const [keepPct, setKeepPct] = useState(100);

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
        setFacilityAirports(p.facilityAirports || {});
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
    () => Array.from(countByOwner.keys()).sort((a, b) => {
      const [fa, sa] = a.split('/');
      const [fb, sb] = b.split('/');
      if (fa !== fb) return fa.localeCompare(fb);            // facility A→Z
      const na = parseInt(sa, 10), nb = parseInt(sb, 10);    // then sector #
      if (!isNaN(na) && !isNaN(nb) && na !== nb) return na - nb;
      return sa.localeCompare(sb);
    }),
    [countByOwner],
  );
  // Facility display order: home ARTCC first, then other Z-centers, then
  // TRACONs / everything else — each alphabetical within its tier.
  const facRank = (f: string) => {
    const home = (cap?.facility || '').toUpperCase();
    return f === home ? 0 : /^Z/.test(f) ? 1 : 2;
  };
  const byFacility = (entries: [string, string[]][]) =>
    entries.sort((a, b) => facRank(a[0]) - facRank(b[0]) || a[0].localeCompare(b[0]));

  // Owners grouped by facility (home/Z-centers first) for a categorized UI.
  const ownersByFacility = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const k of activeOwners) {
      const fac = k.split('/')[0] || '?';
      if (!m.has(fac)) m.set(fac, []);
      m.get(fac)!.push(k);
    }
    return byFacility(Array.from(m.entries()));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeOwners, cap?.facility]);
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
        // 1) ERAM enroute: match the ARTCC sector by eram sectorId.
        let m = positions.find(pp => pp.artcc === f && pp.sectorId && normSec(pp.sectorId) === normSec(s));
        // 2) TRACON/other facility (no eram sectorId): match by facilityId and
        //    pick the facility's approach (e.g. PCT_APP). Note: a STARS position
        //    may reject high/out-of-area replay tracks at load with "ILL TRK"
        //    (non-fatal — those just stay unowned); set the fallback to an
        //    enroute position if you'd rather own that terminal traffic there.
        if (!m) {
          const facPos = positions.filter(pp => pp.facilityId === f);
          if (facPos.length) {
            const up = (c: string | null) => (c || '').toUpperCase();
            m = facPos.find(pp => up(pp.callsign) === `${f}_APP`)
              || facPos.find(pp => up(pp.callsign).includes('_APP'))
              || facPos[0];
          }
        }
        const id = m ? m.id : '';
        if (next[k] !== id) { next[k] = id; changed = true; }
      }
      return changed ? next : prev;
    });
  }, [positions, activeOwners]);

  // Fallback defaults to NONE — unmatched owners stay unowned unless the user
  // explicitly picks a fallback position.

  // ── position picker: one shared datalist for all 1000+ positions (efficient
  // + searchable). label is unique so we can resolve label → id. ──
  const labelToId = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of positions) {
      let l = `${p.facilityId || p.facility || ''}${p.sectorId ? `/${p.sectorId}` : ''} ${p.name || p.callsign || p.id}`;
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
  // Resolve an owner/handoff "FAC/SEC" key to a vNAS position id: ERAM by eram
  // sectorId, else the facility's approach (TRACON). '' if none.
  const matchPosition = (k: string): string => {
    const [f, s] = k.split('/');
    if (!f) return '';
    const m = positions.find(pp => pp.artcc === f && pp.sectorId && normSec(pp.sectorId) === normSec(s));
    if (m) return m.id;
    const facPos = positions.filter(pp => pp.facilityId === f);
    if (facPos.length) {
      const up = (c: string | null) => (c || '').toUpperCase();
      return (facPos.find(pp => up(pp.callsign) === `${f}_APP`)
        || facPos.find(pp => up(pp.callsign).includes('_APP'))
        || facPos[0]).id;
    }
    return '';
  };
  const artccCount = useMemo(() => new Set(positions.map(p => p.artcc).filter(Boolean)).size, [positions]);
  const posLabel = (id: string) => {
    const p = posById(id);
    if (!p) return id;
    // Lead with facilityId/sector (ZTL etc. don't encode the sector in the
    // callsign), then the friendly sector NAME (e.g. "Leeon 55"), not the raw
    // callsign / ARTCC name.
    const f = p.facilityId || p.facility || '';
    return `${f}${p.sectorId ? `/${p.sectorId}` : ''} ${p.name || p.callsign || id}`.trim();
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
  // Stable per-aircraft value in [0,1) so the keep-% is monotonic (raising the
  // percentage only ADDS aircraft, never reshuffles the existing picks).
  const hashUnit = (s: string) => {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return ((h >>> 0) % 100000) / 100000;
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

  // FINAL filter step: include pct% (0=none, 100=all) of the aircraft that pass
  // the airspace filter AND the by-owner selection. Reflected live in the table.
  const eligibleForKeep = (a: CaptureAircraft) =>
    touchesOurAirspace(a) && (ownerSel.size === 0 || ownerSel.has(ownerKey(a)));
  const applyKeep = (pct: number) => {
    setKeepPct(pct);
    setCap(c => (c ? { ...c, aircraft: c.aircraft.map(a => ({ ...a, include: eligibleForKeep(a) && hashUnit(a.gufi) < pct / 100 })) } : c));
  };
  const eligibleCount = aircraft.filter(eligibleForKeep).length;

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
    return { label: posLabel(pid), trainee: traineePositions.has(pid) };
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
        // sectorToPosition maps EVERY active "FAC/SEC" (owners + handoff partners)
        // to its position id, so the replay can target handoffs by position id
        // (HO {positionId}) for any facility — no adaptation codes needed. The
        // same set of positions is staffed with ghosts.
        const map: Record<string, string> = {};
        for (const [k, p] of Object.entries(ownerToPosition)) if (p) map[k] = p;
        const staffSet = new Set<string>();
        const addKey = (key: string) => {
          if (key === '/') return;
          const id = ownerToPosition[key] || matchPosition(key);
          if (id) { map[key] = id; staffSet.add(id); }
        };
        for (const a of included) {
          addKey(ownerKey(a));
          for (const h of (a.handoffs || [])) {
            addKey(`${(h.fromFacility || '').toUpperCase()}/${(h.fromSector || '').toUpperCase()}`);
            addKey(`${(h.toFacility || '').toUpperCase()}/${(h.toSector || '').toUpperCase()}`);
          }
        }
        for (const id of usedPosIds) staffSet.add(id);
        const staffIds = Array.from(staffSet);
        const atcEntries = staffIds.map(id => {
          const p = posById(id);
          // STARS/TRACON positions (terminal, no eram sectorId) auto-track by
          // airport; ERAM positions take per-aircraft control.
          const isStars = !!(p && (p.facilityType ? p.facilityType !== 'Artcc' : !p.sectorId));
          const fid = p?.facilityId || '';
          return {
            positionId: id,
            facilityId: p?.facilityId || p?.artcc || cap.facility || '',
            artccId: p?.artcc || cap.facility || '',
            isStars,
            // Airports this STARS/TRACON controls — autoTrackAirportIds must be a
            // subset of these or vNAS rejects it.
            airports: isStars ? (facilityAirports[fid] || []) : [],
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
  const scopePz = useSvgPanZoom(W, H);
  // Fit the view to the sector polygons AND every included aircraft, so geofenced
  // neighbors/inbounds (well outside the polygons) still show, and the map works
  // even if sector geometry didn't load.
  const box = useMemo(() => {
    let mnLon = Infinity, mnLat = Infinity, mxLon = -Infinity, mxLat = -Infinity;
    const ext = (lon: number, lat: number) => {
      mnLon = Math.min(mnLon, lon); mxLon = Math.max(mxLon, lon);
      mnLat = Math.min(mnLat, lat); mxLat = Math.max(mxLat, lat);
    };
    for (const s of geom) for (const ring of s.rings) for (const [lon, lat] of ring) ext(lon, lat);
    for (const a of aircraft) {
      if (a.include && a.spawn.lat != null && a.spawn.lon != null) ext(a.spawn.lon, a.spawn.lat);
    }
    return Number.isFinite(mnLon) ? { mnLon, mnLat, mxLon, mxLat } : null;
  }, [geom, aircraft]);
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
                value={fallbackPos}
                onChange={e => setFallbackPos(e.target.value)}>
                <option value="">(none — leave unowned)</option>
                {byFacility(Object.entries(mappedPositions.reduce((acc, id) => {
                  const p = posById(id);
                  const f = p?.facilityId || p?.facility || '?';
                  (acc[f] = acc[f] || []).push(id);
                  return acc;
                }, {} as Record<string, string[]>))).map(([f, ids]) => (
                  <optgroup key={f} label={f}>
                    {ids.map(id => <option key={id} value={id}>{posLabel(id)}</option>)}
                  </optgroup>
                ))}
              </select>
              <span style={{ color: 'var(--fg-secondary)' }}>or</span>
              <input list="ssg-positions" className="themed" style={{ minWidth: 200 }}
                value="" placeholder="search any position…"
                onChange={e => { const id = labelToId.get(e.target.value); if (id) setFallbackPos(id); }} />
            </label>
            <div style={{ maxHeight: '55vh', overflowY: 'auto', overflowX: 'hidden', fontSize: 12, border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: 6 }}>
              {ownersByFacility.map(([fac, keys]) => (
                <div key={fac} style={{ marginBottom: 4 }}>
                  <div style={{ fontWeight: 600, fontSize: 11, color: 'var(--accent, #8ab4f8)', margin: '5px 0 2px', position: 'sticky', top: 0, background: 'var(--bg-primary, #1a1a1a)' }}>
                    {fac} <span style={{ fontWeight: 400, color: 'var(--fg-secondary)' }}>({keys.length} sector{keys.length === 1 ? '' : 's'})</span>
                  </div>
                  {keys.map(k => (
                    <div key={k} className="row" style={{ gap: 8, alignItems: 'center', marginBottom: 3, paddingLeft: 8 }}>
                      <span style={{ width: 64, fontFamily: 'monospace' }}>
                        {k.split('/')[1]} <span style={{ color: 'var(--fg-secondary)' }}>({countByOwner.get(k) || 0})</span>
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
          <div style={{ maxHeight: 140, overflow: 'auto' }}>
            {byFacility(Object.entries(usedPosIds.reduce((acc, id) => {
              const p = posById(id);
              const f = p?.facilityId || p?.facility || '?';
              (acc[f] = acc[f] || []).push(id);
              return acc;
            }, {} as Record<string, string[]>))).map(([f, ids]) => (
              <div key={f} className="row" style={{ gap: 5, flexWrap: 'wrap', alignItems: 'center', marginBottom: 4 }}>
                <span style={{ width: 44, fontSize: 11, fontWeight: 600, color: 'var(--accent, #8ab4f8)' }}>{f}</span>
                {ids.map(id => {
                  const p = posById(id);
                  const label = p ? `${p.sectorId ? `${p.sectorId} ` : ''}${p.name || p.callsign || id}` : id;
                  return (
                    <span key={id} style={chip(traineePositions.has(id))}
                      onClick={() => toggle(traineePositions, setTraineePositions, id)}>{label}</span>
                  );
                })}
              </div>
            ))}
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
        </div>
        {activeOwners.length > 0 && (
          <div style={{ marginTop: 8 }}>
            <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
              <span style={{ fontSize: 12, color: 'var(--fg-secondary)' }}>By owner (grouped by facility):</span>
              <ThemedButton secondary onClick={includeOnlyOwners} disabled={ownerSel.size === 0}>Include only selected</ThemedButton>
            </div>
            <div style={{ maxHeight: 160, overflow: 'auto' }}>
              {ownersByFacility.map(([fac, keys]) => (
                <div key={fac} className="row" style={{ gap: 5, flexWrap: 'wrap', alignItems: 'center', marginBottom: 4 }}>
                  <span style={{ width: 44, fontSize: 11, fontWeight: 600, color: 'var(--accent, #8ab4f8)' }}>{fac}</span>
                  {keys.map(k => (
                    <span key={k} style={chip(ownerSel.has(k))} onClick={() => toggle(ownerSel, setOwnerSel, k)}>
                      {k.split('/')[1]} ({countByOwner.get(k) || 0})
                    </span>
                  ))}
                </div>
              ))}
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
        {/* FINAL step: keep a percentage of the (airspace + owner) filtered set. */}
        <div style={{ marginTop: 12, paddingTop: 10, borderTop: '1px solid var(--border)' }}>
          <div className="row" style={{ gap: 10, alignItems: 'center' }}>
            <span style={{ fontSize: 12, fontWeight: 600 }}>Final amount:</span>
            <input type="range" min={0} max={100} step={5} value={keepPct} style={{ flex: 1, maxWidth: 320 }}
              onChange={e => applyKeep(Number(e.target.value))} />
            <span style={{ fontVariantNumeric: 'tabular-nums', width: 40, textAlign: 'right' }}>{keepPct}%</span>
            <span style={{ fontSize: 12, color: 'var(--fg-secondary)' }}>
              → {included.length} of {eligibleCount}{ownerSel.size > 0 ? ' (selected owners)' : ''}
            </span>
          </div>
          <p style={{ fontSize: 11, color: 'var(--fg-secondary)', margin: '4px 0 0' }}>
            Keeps this % of aircraft that enter {ourFac}{ownerSel.size > 0 ? ' and belong to the selected owners' : ''}.
            0 = none, 100 = all. Applied as the last filter — the table below updates to match.
          </p>
        </div>
      </Section>

      {/* scope */}
      <div style={{ position: 'relative', margin: '10px 0' }}>
        <span style={{ position: 'absolute', top: 4, right: 8, fontSize: 10, color: 'var(--fg-secondary)', pointerEvents: 'none' }}>
          scroll to zoom · drag to pan · double-click to reset
        </span>
      <svg ref={scopePz.ref} width="100%" viewBox={scopePz.viewBox} {...scopePz.panHandlers}
        style={{ background: '#0b0f14', border: '1px solid var(--border)', borderRadius: 'var(--radius)', cursor: 'grab', touchAction: 'none', userSelect: 'none' }}>
        {geom.map((s, si) => s.rings.map((ring, ri) => (
          <polyline key={`${si}-${ri}`} points={ring.map(([lon, lat]) => project(lon, lat).join(',')).join(' ')}
            fill="none" stroke="#2e7d32" strokeWidth={scopePz.k} opacity={0.7} />
        )))}
        {box && aircraft.map(a => {
          if (a.spawn.lat == null || a.spawn.lon == null) return null;
          const [x, y] = project(a.spawn.lon, a.spawn.lat);
          const color = !a.include ? '#52606d' : a.category === 'vicinity' ? '#7aa2ff' : '#39ff88';
          const k = scopePz.k;
          return (
            <g key={a.gufi}>
              <circle cx={x} cy={y} r={(a.include ? 3 : 2) * k} fill={color} />
              {a.include && <text x={x + 5 * k} y={y + 3 * k} fill={color} fontSize={8 * k} fontFamily="monospace">{a.callsign}</text>}
            </g>
          );
        })}
      </svg>
      </div>

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
