import type { Request, ShiftState } from '../../lib/types';
import { useChat } from '../../store/chat';
import { useCall } from '../../store/call';
import { toast } from '../../components/ui';
import { cx, mmss } from '../../lib/format';

export const NORM = 900;

export const STATUS_TONE: Record<string, string> = {
  waiting: 'amber', assigned: 'accent', enroute: 'accent', arrived: 'green', working: 'green', done: 'muted', cancelled: 'muted',
};

export function StatusPill({ r }: { r: Request }) {
  return <span className={cx('pill', `pill-${STATUS_TONE[r.status] || 'muted'}`, r.priority === 'emergency' && 'pill-red')}>{r.priority === 'emergency' ? 'ЧС · ' : ''}{r.status_ru}</span>;
}

/** SLA bar: elapsed vs 15-minute norm; turns amber at 80%, red when violated. */
export function SlaBar({ r }: { r: Request }) {
  const done = r.status === 'arrived' || r.status === 'working';
  const elapsed = done && r.arrived_sim != null ? r.arrived_sim - r.created_sim : r.elapsed;
  const pct = Math.min(100, (elapsed / NORM) * 100);
  const tone = pct >= 100 ? 'red' : pct >= 80 ? 'amber' : done ? 'green' : 'accent';
  return <div className={cx('sla', `sla-${tone}`)}><i style={{ transform: `scaleX(${pct / 100})` }} /></div>;
}

export const slaLeft = (r: Request) => NORM - (r.elapsed || 0);

export function Countdown({ r }: { r: Request }) {
  if (r.status === 'enroute' || r.status === 'assigned') return <>{mmss(r.eta_left)}</>;
  if (r.status === 'waiting') return <span className="t-amber">ожидание</span>;
  return <span className="t-green">на месте</span>;
}

/** Map a technician to his user account (for chat & calls). */
export function useTechContact(techId: number | null | undefined) {
  return useChat(s => (techId == null ? null : s.contacts.find(c => c.tech_id === techId) ?? null));
}

export async function messageUser(userId: number) {
  const chat = useChat.getState();
  chat.setOpen(true);
  await chat.openDirect(userId);
}

export function callUser(userId: number | undefined, name: string) {
  if (!userId) { toast.bad('У сотрудника нет активного аккаунта для связи'); return; }
  useCall.getState().start(userId, name);
}

export function kpis(state: ShiftState) {
  const closed = [...state.history, ...state.active].filter(r => r.arrived_sim != null && r.created_sim != null);
  const times = closed.map(r => (r.arrived_sim! - r.created_sim) / 60).filter(v => v >= 0);
  const avg = times.length ? times.reduce((a, b) => a + b, 0) / times.length : null;
  const sla = times.length ? (times.filter(v => v <= 15).length / times.length) * 100 : null;
  return { avg, sla, closed: state.history.length };
}
