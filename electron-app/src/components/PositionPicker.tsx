import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

export interface PosOption {
  id: string;
  label: string;
}

/**
 * Searchable position combobox. Replaces the native <datalist> (which doesn't
 * scroll reliably and filters inconsistently). Type to filter; the dropdown
 * renders in a portal with fixed positioning so it isn't clipped by the
 * surrounding scroll container.
 */
export function PositionPicker({
  value,
  options,
  onChange,
  placeholder = 'search position…',
  minWidth = 240,
  noneLabel = '(none / use fallback)',
}: {
  value: string; // selected position id ('' = none)
  options: PosOption[];
  onChange: (id: string) => void; // '' clears
  placeholder?: string;
  minWidth?: number;
  noneLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [rect, setRect] = useState<DOMRect | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const selectedLabel = useMemo(
    () => options.find(o => o.id === value)?.label ?? '',
    [options, value],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const src = q ? options.filter(o => o.label.toLowerCase().includes(q)) : options;
    return src.slice(0, 300); // cap for render perf; typing narrows the list
  }, [options, query]);

  const openMenu = () => {
    if (inputRef.current) setRect(inputRef.current.getBoundingClientRect());
    setQuery('');
    setOpen(true);
  };
  const close = () => setOpen(false);

  const pick = (id: string) => {
    onChange(id);
    setQuery('');
    setOpen(false);
    inputRef.current?.blur();
  };

  // Close on outside click (accounting for the portalled menu).
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (wrapRef.current?.contains(t) || menuRef.current?.contains(t)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  // A fixed-position menu can't follow scroll/resize — close so it never floats
  // detached over the wrong row. Capture phase catches inner-container scrolls.
  useEffect(() => {
    if (!open) return;
    const onMove = () => setOpen(false);
    window.addEventListener('scroll', onMove, true);
    window.addEventListener('resize', onMove);
    return () => {
      window.removeEventListener('scroll', onMove, true);
      window.removeEventListener('resize', onMove);
    };
  }, [open]);

  const rowStyle = (active: boolean): React.CSSProperties => ({
    padding: '5px 8px',
    cursor: 'pointer',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    background: active ? 'var(--accent, #3b82f6)' : 'transparent',
    color: active ? '#fff' : 'inherit',
  });

  return (
    <div ref={wrapRef} style={{ position: 'relative', minWidth, display: 'inline-block' }}>
      <input
        ref={inputRef}
        className="themed"
        style={{ width: '100%' }}
        value={open ? query : selectedLabel}
        placeholder={value ? placeholder : `${placeholder}`}
        onFocus={openMenu}
        onChange={e => { setQuery(e.target.value); if (!open) openMenu(); }}
        onKeyDown={e => {
          if (e.key === 'Enter' && filtered.length) { e.preventDefault(); pick(filtered[0].id); }
          else if (e.key === 'Escape') { e.preventDefault(); close(); inputRef.current?.blur(); }
        }}
      />
      {open && rect && createPortal(
        <div
          ref={menuRef}
          style={{
            position: 'fixed',
            top: Math.min(rect.bottom + 2, window.innerHeight - 8),
            left: rect.left,
            width: Math.max(rect.width, 240),
            maxHeight: 280,
            overflowY: 'auto',
            zIndex: 9999,
            background: 'var(--bg-primary, #1e1e1e)',
            border: '1px solid var(--border, #444)',
            borderRadius: 'var(--radius, 6px)',
            boxShadow: '0 8px 24px rgba(0,0,0,0.45)',
            fontSize: 12,
          }}
        >
          <div onClick={() => pick('')} style={{ ...rowStyle(!value), fontStyle: 'italic', color: 'var(--fg-secondary)' }}>
            {noneLabel}
          </div>
          {filtered.map(o => (
            <div key={o.id} onClick={() => pick(o.id)} style={rowStyle(o.id === value)} title={o.label}>
              {o.label}
            </div>
          ))}
          {filtered.length === 0 && (
            <div style={{ padding: '5px 8px', color: 'var(--fg-secondary)' }}>no matches</div>
          )}
        </div>,
        document.body,
      )}
    </div>
  );
}
