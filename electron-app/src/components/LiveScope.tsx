import { useEffect, useRef, useState } from 'react';
import type { SectorGeometry } from '../../shared/types';
import { useSvgPanZoom } from '../hooks/useSvgPanZoom';

/** Normalize a sector id the same way the Python side does: uppercase, drop
 *  non-alphanumerics, strip leading zeros (so 7 == 07). */
function normSector(s: string): string {
  const t = (s || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase().replace(/^0+/, '');
  return t || '0';
}

interface Track {
  gufi: string;
  callsign: string;
  lat: number;
  lon: number;
  alt: number | null;
  type: string;
  fac: string;
  sec: string;
  origin: string;
  destination: string;
  hasRoute: boolean;
  handoffIn: string;   // handoffReceiving (flashing to a position)
  handoffOut: string;  // handoffTransferring
}

const W = 640;
const H = 460;
const PAD = 24;

/**
 * Lightweight in-app radar scope: draws the selected sector polygons (from the
 * bundled KML) and live tracks straight from SwimServer's WebSocket, filtered
 * to exactly what the capture is taking (the chosen facility + sectors).
 *
 * Green = being captured (owned by a selected sector, has a route). Amber =
 * owned but no route yet (skipped on cold start). Grey = nearby, not ours.
 */
export function LiveScope({
  facility,
  allSectors,
  sectorList,
  vicinityNm = 0,
}: {
  facility: string;
  allSectors: boolean;
  sectorList: string[];
  vicinityNm?: number;
}) {
  const [geometry, setGeometry] = useState<SectorGeometry[]>([]);
  const [tracks, setTracks] = useState<Track[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const tracksRef = useRef<Map<string, Track>>(new Map());
  const pz = useSvgPanZoom(W, H);

  const fac = facility.trim().toUpperCase();
  const selected = new Set(sectorList.map(normSector));
  const isSelectedSector = (sec: string) => allSectors || selected.has(normSector(sec));

  // Fetch sector polygons for the facility.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const r = await window.ssg.liveCapture.getSectorGeometry(fac);
      if (cancelled) return;
      if (r.status === 'ok' && r.sectors) {
        setGeometry(allSectors ? r.sectors : r.sectors.filter(s => selected.has(normSector(s.sector))));
      } else {
        setErr(r.message ?? 'no sector geometry');
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fac, allSectors, sectorList.join(',')]);

  // Live WS feed from SwimServer (running during capture).
  useEffect(() => {
    let ws: WebSocket | null = null;
    try {
      ws = new WebSocket('ws://localhost:5001/ws');
    } catch {
      return;
    }
    const ingest = (f: Record<string, unknown>) => {
      const gufi = f.gufi as string;
      if (!gufi) return;
      const lat = f.latitude as number | null;
      const lon = f.longitude as number | null;
      if (lat == null || lon == null) {
        tracksRef.current.delete(gufi);
        return;
      }
      tracksRef.current.set(gufi, {
        gufi,
        callsign: (f.callsign as string) || gufi,
        lat,
        lon,
        alt: (f.reportedAltitude as number) ?? (f.assignedAltitude as number) ?? null,
        type: (f.aircraftType as string) || '',
        fac: ((f.controllingFacility as string) || '').toUpperCase(),
        sec: (f.controllingSector as string) || '',
        origin: (f.origin as string) || '',
        destination: (f.destination as string) || '',
        hasRoute: !!((f.route as string) || (f.originalRoute as string)),
        handoffIn: (f.handoffReceiving as string) || '',
        handoffOut: (f.handoffTransferring as string) || '',
      });
    };
    ws.onmessage = ev => {
      try {
        const msg = JSON.parse(ev.data as string);
        if ((msg.type === 'snapshot' || msg.type === 'batch') && Array.isArray(msg.data)) {
          for (const f of msg.data) ingest(f);
        } else if (msg.type === 'remove') {
          const d = msg.data;
          const ids = Array.isArray(d) ? d : [d];
          for (const x of ids) tracksRef.current.delete(typeof x === 'string' ? x : x?.gufi);
        }
      } catch {
        /* ignore */
      }
    };
    const id = setInterval(() => setTracks(Array.from(tracksRef.current.values())), 1000);
    return () => {
      clearInterval(id);
      try {
        ws?.close();
      } catch {
        /* ignore */
      }
    };
  }, []);

  // Bounding box from the selected sector rings.
  let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity;
  for (const s of geometry)
    for (const ring of s.rings)
      for (const [lon, lat] of ring) {
        if (lon < minLon) minLon = lon;
        if (lon > maxLon) maxLon = lon;
        if (lat < minLat) minLat = lat;
        if (lat > maxLat) maxLat = lat;
      }
  const haveBox = Number.isFinite(minLon);
  const midLat = haveBox ? (minLat + maxLat) / 2 : 0;
  const lonScale = Math.cos((midLat * Math.PI) / 180) || 1;
  // Geofence ring = the polygon bbox expanded by the capture radius (matches the
  // bridge's vicinity_bbox). The VIEW adds a small margin so a thin ring of
  // not-captured "other traffic" stays visible at the edges.
  const dLat = vicinityNm / 60;
  const dLon = vicinityNm / 60 / lonScale;
  const gMinLon = minLon - dLon, gMaxLon = maxLon + dLon, gMinLat = minLat - dLat, gMaxLat = maxLat + dLat;
  const mLon = (gMaxLon - gMinLon) * 0.12, mLat = (gMaxLat - gMinLat) * 0.12;
  const vMinLon = gMinLon - mLon, vMaxLon = gMaxLon + mLon, vMinLat = gMinLat - mLat, vMaxLat = gMaxLat + mLat;
  const spanLon = haveBox ? (vMaxLon - vMinLon) * lonScale || 1 : 1;
  const spanLat = haveBox ? vMaxLat - vMinLat || 1 : 1;
  const scale = Math.min((W - 2 * PAD) / spanLon, (H - 2 * PAD) / spanLat);
  const project = (lon: number, lat: number): [number, number] => [
    PAD + (lon - vMinLon) * lonScale * scale,
    PAD + (vMaxLat - lat) * scale,
  ];

  const mineOf = (t: Track) => t.fac === fac && isSelectedSector(t.sec);
  // What the capture actually records: owned/geometry always, plus anything in
  // the geofence bbox when a radius is set.
  const capturedOf = (t: Track) =>
    mineOf(t) || (vicinityNm > 0 && t.lon >= gMinLon && t.lon <= gMaxLon && t.lat >= gMinLat && t.lat <= gMaxLat);

  const ours = tracks
    .filter(capturedOf)
    .sort((a, b) => a.callsign.localeCompare(b.callsign));
  const captured = ours.filter(t => t.hasRoute).length;

  const inView = (t: Track) =>
    haveBox && t.lon >= vMinLon && t.lon <= vMaxLon && t.lat >= vMinLat && t.lat <= vMaxLat;

  return (
    <div className="row" style={{ gap: 12, alignItems: 'flex-start', flexWrap: 'wrap' }}>
      <div style={{ flex: '1 1 640px', position: 'relative' }}>
        <span style={{ position: 'absolute', top: 4, right: 8, fontSize: 10, color: 'var(--fg-secondary)', pointerEvents: 'none' }}>
          scroll to zoom · drag to pan · double-click to reset
        </span>
        <svg
          ref={pz.ref}
          width="100%"
          viewBox={pz.viewBox}
          {...pz.panHandlers}
          style={{ background: '#0b0f14', border: '1px solid var(--border)', borderRadius: 'var(--radius)', cursor: 'grab', touchAction: 'none' }}
        >
          {/* sector polygons */}
          {geometry.map((s, si) =>
            s.rings.map((ring, ri) => (
              <polyline
                key={`${si}-${ri}`}
                points={ring.map(([lon, lat]) => project(lon, lat).join(',')).join(' ')}
                fill="none"
                stroke="#2e7d32"
                strokeWidth={1}
                opacity={0.8}
              />
            )),
          )}
          {/* geofence ring (the capture radius) */}
          {haveBox && vicinityNm > 0 && (() => {
            const [x1, y1] = project(gMinLon, gMaxLat);
            const [x2, y2] = project(gMaxLon, gMinLat);
            return <rect x={x1} y={y1} width={x2 - x1} height={y2 - y1} fill="none"
              stroke="#3a4a5a" strokeWidth={1} strokeDasharray="4 4" />;
          })()}
          {/* tracks */}
          {haveBox &&
            tracks.filter(inView).map(t => {
              const [x, y] = project(t.lon, t.lat);
              const cap = capturedOf(t);
              const mine = mineOf(t);
              const color = !cap ? '#52606d' : !t.hasRoute ? '#ffd24a' : mine ? '#39ff88' : '#7aa2ff';
              return (
                <g key={t.gufi}>
                  <circle cx={x} cy={y} r={cap ? 3 : 2} fill={color} />
                  {cap && (
                    <text x={x + 5} y={y + 3} fill={color} fontSize={9} fontFamily="monospace">
                      {t.callsign} {t.alt ? Math.round(t.alt / 100) : ''}
                    </text>
                  )}
                </g>
              );
            })}
          {err && (
            <text x={PAD} y={PAD} fill="#c77" fontSize={12}>
              {err}
            </text>
          )}
        </svg>
        <div style={{ fontSize: 11, color: 'var(--fg-secondary)', marginTop: 4 }}>
          <span style={{ color: '#39ff88' }}>● owned (you)</span>{'  '}
          <span style={{ color: '#7aa2ff' }}>● neighbor/inbound (captured)</span>{'  '}
          <span style={{ color: '#ffd24a' }}>● no route yet</span>{'  '}
          <span style={{ color: '#52606d' }}>● not captured</span>
        </div>
      </div>

      <div style={{ flex: '1 1 240px', maxHeight: H, overflow: 'auto' }}>
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>
          {fac} — {ours.length} captured · {captured} with route
        </div>
        <table style={{ width: '100%', fontSize: 11, borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ textAlign: 'left', color: 'var(--fg-secondary)' }}>
              <th style={{ paddingRight: 6 }}>Callsign</th>
              <th style={{ paddingRight: 6 }}>Type</th>
              <th style={{ paddingRight: 6 }}>Dep→Dest</th>
              <th style={{ paddingRight: 6, textAlign: 'right' }}>Alt</th>
              <th style={{ paddingRight: 6 }}>Owner</th>
              <th>H/O</th>
            </tr>
          </thead>
          <tbody>
            {ours.map(t => {
              const ho = t.handoffOut ? `out→${t.handoffOut}` : t.handoffIn ? `in←${t.handoffIn}` : '';
              return (
                <tr key={t.gufi} style={{ opacity: t.hasRoute ? 1 : 0.55 }}>
                  <td style={{ fontFamily: 'monospace', paddingRight: 6 }}>{t.callsign}</td>
                  <td style={{ color: 'var(--fg-secondary)', paddingRight: 6 }}>{t.type}</td>
                  <td style={{ whiteSpace: 'nowrap', color: 'var(--fg-secondary)', paddingRight: 6 }}>
                    {(t.origin || '?')}→{(t.destination || '?')}
                  </td>
                  <td style={{ textAlign: 'right', paddingRight: 6 }}>{t.alt ? Math.round(t.alt / 100) : '—'}</td>
                  <td style={{ whiteSpace: 'nowrap', paddingRight: 6 }}>{t.fac}/{t.sec}</td>
                  <td style={{ whiteSpace: 'nowrap', color: ho ? 'var(--warning, #ffd24a)' : 'var(--fg-secondary)' }}>{ho}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
