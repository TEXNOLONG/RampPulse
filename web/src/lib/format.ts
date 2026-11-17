export const mmss = (sec: number | null | undefined) => {
  if (sec == null || !Number.isFinite(sec)) return '—';
  const s = Math.max(0, Math.round(sec));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};

export const minutes = (sec: number | null | undefined, digits = 1) =>
  sec == null || !Number.isFinite(sec) ? '—' : (sec / 60).toFixed(digits);

/** Simulation seconds → wall clock of the shift (shift starts 06:00). */
export const simClock = (simSec: number | null | undefined) => {
  if (simSec == null) return '—';
  const base = new Date(); base.setHours(6, 0, 0, 0);
  const t = new Date(base.getTime() + simSec * 1000);
  return `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;
};

export const timeHM = (iso: string | null | undefined) => {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
};

export const dayLabel = (iso: string) => {
  const d = new Date(iso);
  const today = new Date();
  const yesterday = new Date(); yesterday.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return 'Сегодня';
  if (d.toDateString() === yesterday.toDateString()) return 'Вчера';
  return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
};

export const initials = (name: string | null | undefined) =>
  (name || '?').trim().split(/\s+/).filter(Boolean).slice(0, 2).map(p => p[0]).join('').toUpperCase() || '?';

export const plural = (n: number, one: string, few: string, many: string) => {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return few;
  return many;
};

export const cx = (...parts: (string | false | null | undefined)[]) => parts.filter(Boolean).join(' ');

export const QUAL_COLOR: Record<string, string> = {
  'Планер': '#22D3EE',
  'Двигатель': '#F59E0B',
  'Авионика': '#A78BFA',
};
export const qualColor = (q: string | null | undefined) => (q && QUAL_COLOR[q]) || '#A1A1AA';
