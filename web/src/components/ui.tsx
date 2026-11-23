import { create } from 'zustand';
import { useEffect, useRef, useState, type ReactNode, type ButtonHTMLAttributes } from 'react';
import { X, CheckCircle2, AlertTriangle, Info } from 'lucide-react';
import { cx, initials } from '../lib/format';

/* ------------------------------------------------------------------ Avatar */
export function Avatar({ name, color, size = 36, online, ring, src }: { name?: string | null; color?: string | null; size?: number; online?: boolean; ring?: boolean; src?: string }) {
  const [imageFailed, setImageFailed] = useState(false);
  useEffect(() => setImageFailed(false), [src]);
  const c = color && /^#[0-9a-f]{6}$/i.test(color) ? color : '#000000';
  return (
    <span className={cx('avatar', ring && 'avatar-ring')} style={{ width: size, height: size, fontSize: Math.round(size * 0.38), background: `linear-gradient(140deg, ${c}, ${shade(c, -0.45)})` }}>
      {src && !imageFailed ? <img className="avatar-image" src={src} alt="" onError={() => setImageFailed(true)} /> : initials(name)}
      {online != null && <i className={cx('presence', online && 'on')} />}
    </span>
  );
}

function shade(hex: string, amount: number) {
  const n = parseInt(hex.slice(1), 16);
  const f = (v: number) => Math.max(0, Math.min(255, Math.round(v + (amount < 0 ? v * amount : (255 - v) * amount))));
  const r = f(n >> 16), g = f((n >> 8) & 255), b = f(n & 255);
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`;
}

/* ------------------------------------------------------------------ Button */
type Variant = 'primary' | 'ghost' | 'danger' | 'success' | 'subtle';
export function Button({ variant = 'ghost', size, block, loading, icon, children, className, ...rest }:
  ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: 'sm' | 'lg'; block?: boolean; loading?: boolean; icon?: ReactNode }) {
  return (
    <button className={cx('btn', `btn-${variant}`, size && `btn-${size}`, block && 'btn-block', loading && 'is-loading', className)} disabled={rest.disabled || loading} {...rest}>
      {loading ? <span className="spinner" /> : icon}
      {children && <span>{children}</span>}
    </button>
  );
}

export function IconButton({ label, children, className, badge, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; badge?: number }) {
  return (
    <button className={cx('icon-btn', className)} aria-label={label} title={label} {...rest}>
      {children}
      {badge ? <span className="badge-dot">{badge > 99 ? '99+' : badge}</span> : null}
    </button>
  );
}

/* ------------------------------------------------------------------ Switch / Segmented */
export function Switch({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label?: string }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} className={cx('switch', checked && 'on')} onClick={() => onChange(!checked)}>
      <i />
    </button>
  );
}

export function Segmented<T extends string | number>({ value, options, onChange }: { value: T; options: { value: T; label: ReactNode }[]; onChange: (v: T) => void }) {
  return (
    <div className="segmented" role="tablist">
      {options.map(o => (
        <button key={String(o.value)} type="button" role="tab" aria-selected={o.value === value} className={cx(o.value === value && 'on')} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ Modal & Sheet */
export function Modal({ open, onClose, title, eyebrow, children, footer, width = 480, className }:
  { open: boolean; onClose: () => void; title?: ReactNode; eyebrow?: ReactNode; children: ReactNode; footer?: ReactNode; width?: number; className?: string }) {
  useEscape(open, onClose);
  if (!open) return null;
  return (
    <div className="overlay" onMouseDown={e => e.target === e.currentTarget && onClose()}>
      <div className={cx('modal', className)} style={{ width: `min(${width}px, calc(100vw - 24px))` }} role="dialog" aria-modal="true">
        {(title || eyebrow) && (
          <header className="modal-head">
            <div>{eyebrow && <span className="eyebrow">{eyebrow}</span>}{title && <h2>{title}</h2>}</div>
            <IconButton label="Закрыть" onClick={onClose}><X size={18} /></IconButton>
          </header>
        )}
        <div className="modal-body">{children}</div>
        {footer && <footer className="modal-foot">{footer}</footer>}
      </div>
    </div>
  );
}

/** Side drawer on desktop, bottom sheet on phones. */
export function Sheet({ open, onClose, children, side = 'right', width = 420, className, title }:
  { open: boolean; onClose: () => void; children: ReactNode; side?: 'right' | 'bottom'; width?: number; className?: string; title?: ReactNode }) {
  useEscape(open, onClose);
  if (!open) return null;
  return (
    <div className={cx('overlay', 'overlay-sheet', `sheet-${side}`)} onMouseDown={e => e.target === e.currentTarget && onClose()}>
      <aside className={cx('sheet', className)} style={side === 'right' ? { width: `min(${width}px, 100vw)` } : undefined} role="dialog" aria-modal="true">
        {title && <header className="sheet-head"><h2>{title}</h2><IconButton label="Закрыть" onClick={onClose}><X size={18} /></IconButton></header>}
        {children}
      </aside>
    </div>
  );
}

function useEscape(active: boolean, onClose: () => void) {
  const cb = useRef(onClose); cb.current = onClose;
  useEffect(() => {
    if (!active) return;
    const h = (e: KeyboardEvent) => e.key === 'Escape' && cb.current();
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [active]);
}

/* ------------------------------------------------------------------ Toasts */
interface Toast { id: number; text: string; tone: 'ok' | 'bad' | 'info'; title?: string }
export const useToasts = create<{ items: Toast[]; push(t: Omit<Toast, 'id'>): void; drop(id: number): void }>(set => ({
  items: [],
  push: t => {
    const id = Date.now() + Math.random();
    set(s => ({ items: [...s.items.slice(-3), { ...t, id }] }));
    setTimeout(() => set(s => ({ items: s.items.filter(i => i.id !== id) })), t.tone === 'bad' ? 6000 : 3800);
  },
  drop: id => set(s => ({ items: s.items.filter(i => i.id !== id) })),
}));
export const toast = {
  ok: (text: string, title?: string) => useToasts.getState().push({ text, title, tone: 'ok' }),
  bad: (text: string, title?: string) => useToasts.getState().push({ text, title, tone: 'bad' }),
  info: (text: string, title?: string) => useToasts.getState().push({ text, title, tone: 'info' }),
};
export function Toaster() {
  const { items, drop } = useToasts();
  return (
    <div className="toaster" aria-live="polite">
      {items.map(t => (
        <div key={t.id} className={cx('toast', `toast-${t.tone}`)} onClick={() => drop(t.id)}>
          {t.tone === 'ok' ? <CheckCircle2 size={18} /> : t.tone === 'bad' ? <AlertTriangle size={18} /> : <Info size={18} />}
          <div>{t.title && <b>{t.title}</b>}<span>{t.text}</span></div>
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ misc */
export function Empty({ icon, title, text, children }: { icon?: ReactNode; title: string; text?: string; children?: ReactNode }) {
  return (
    <div className="empty">
      {icon && <span className="empty-icon">{icon}</span>}
      <b>{title}</b>
      {text && <p>{text}</p>}
      {children}
    </div>
  );
}

export function Kbd({ children }: { children: ReactNode }) { return <kbd className="kbd">{children}</kbd>; }

export function Field({ label, hint, error, children }: { label: string; hint?: ReactNode; error?: string | null; children: ReactNode }) {
  return (
    <label className={cx('field', error && 'has-error')}>
      <span className="field-label">{label}</span>
      {children}
      {error ? <small className="field-error">{error}</small> : hint ? <small className="field-hint">{hint}</small> : null}
    </label>
  );
}
