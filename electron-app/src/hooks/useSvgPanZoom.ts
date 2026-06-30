import { useEffect, useRef, useState } from 'react';

/**
 * Wheel-zoom + drag-pan for an SVG that draws content in a fixed [0..W]x[0..H]
 * coordinate space. Returns a ref for the <svg>, the current viewBox string,
 * drag handlers, and a reset(). Zoom keeps the point under the cursor fixed.
 *
 * Wheel is bound via a native non-passive listener (React's onWheel is passive,
 * so preventDefault there won't stop page scroll).
 */
export function useSvgPanZoom(W: number, H: number) {
  const [vb, setVb] = useState({ x: 0, y: 0, w: W, h: H });
  const ref = useRef<SVGSVGElement | null>(null);
  const drag = useRef<{ sx: number; sy: number; ox: number; oy: number; w: number; h: number } | null>(null);

  useEffect(() => {
    const svg = ref.current;
    if (!svg) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = svg.getBoundingClientRect();
      const px = (e.clientX - r.left) / r.width;
      const py = (e.clientY - r.top) / r.height;
      setVb(p => {
        const f = e.deltaY < 0 ? 0.85 : 1 / 0.85;
        const nw = Math.max(W / 60, Math.min(W * 3, p.w * f));
        const nh = nw * (H / W);
        const cx = p.x + px * p.w;
        const cy = p.y + py * p.h;
        return { x: cx - px * nw, y: cy - py * nh, w: nw, h: nh };
      });
    };
    svg.addEventListener('wheel', onWheel, { passive: false });
    return () => svg.removeEventListener('wheel', onWheel);
  }, [W, H]);

  const onMouseDown = (e: React.MouseEvent<SVGSVGElement>) => {
    drag.current = { sx: e.clientX, sy: e.clientY, ox: vb.x, oy: vb.y, w: vb.w, h: vb.h };
  };
  const onMouseMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const d = drag.current;
    if (!d) return;
    const r = e.currentTarget.getBoundingClientRect();
    const dx = ((e.clientX - d.sx) / r.width) * d.w;
    const dy = ((e.clientY - d.sy) / r.height) * d.h;
    setVb({ x: d.ox - dx, y: d.oy - dy, w: d.w, h: d.h });
  };
  const onMouseUp = () => { drag.current = null; };

  const reset = () => setVb({ x: 0, y: 0, w: W, h: H });
  const zoomed = vb.x !== 0 || vb.y !== 0 || vb.w !== W || vb.h !== H;

  return {
    ref,
    viewBox: `${vb.x} ${vb.y} ${vb.w} ${vb.h}`,
    reset,
    zoomed,
    panHandlers: { onMouseDown, onMouseMove, onMouseUp, onMouseLeave: onMouseUp, onDoubleClick: reset },
  };
}
