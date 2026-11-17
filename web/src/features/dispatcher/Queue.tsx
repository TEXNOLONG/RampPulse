import { useMemo, useState } from 'react';
import { Plus, PlaneLanding, Search, ClipboardList, Plane, Users, ScrollText, UserCheck, UserX, Inbox, MessageSquare, Phone } from 'lucide-react';
import type { Request, ShiftState, Technician, Aircraft, User } from '../../lib/types';
import { useOps, act } from '../../store/ops';
import { Avatar, Button, Empty, IconButton, toast } from '../../components/ui';
import { cx, mmss, qualColor, simClock, timeHM } from '../../lib/format';
import { Countdown, SlaBar, StatusPill, callUser, messageUser, useTechContact } from './shared';
import { errorText } from '../../lib/api';
import { useChat } from '../../store/chat';

export type QueueTab = 'requests' | 'flights' | 'team' | 'log';

interface Props {
  tab: QueueTab;
  onTab(t: QueueTab): void;
  selected: { request: number | null; tech: number | null; aircraft: number | null };
  onSelectRequest(id: number): void;
  onSelectTech(id: number): void;
  onSelectAircraft(id: number): void;
  onNewRequest(stand?: string): void;
}

export function Queue({ tab, onTab, selected, onSelectRequest, onSelectTech, onSelectAircraft, onNewRequest }: Props) {
  const state = useOps(s => s.state)!;
  const [q, setQ] = useState('');
  const query = q.trim().toLowerCase();
  const match = (...fields: (string | null | undefined)[]) => !query || fields.some(f => f?.toLowerCase().includes(query));

  const requests = useMemo(() => [...state.active].sort((a, b) => prio(b) - prio(a) || a.created_sim - b.created_sim)
    .filter(r => match(r.stand, r.description, r.tech_name, r.flight, String(r.id))), [state, query]);
  const regCount = state.registrations?.length || 0;

  return (
    <aside className="queue">
      <header className="queue-head">
        <div className="queue-title"><div><span className="eyebrow">Операционный центр</span><h1>Очередь смены</h1></div></div>
        <div className="queue-actions">
          <Button variant="primary" icon={<Plus size={17} />} onClick={() => onNewRequest()} block>Новая заявка</Button>
          <IconButton label="Добавить входящий рейс" className="btn-like" onClick={() => act.spawnAircraft().then(() => toast.ok('Борт заходит на посадку')).catch(e => toast.bad(errorText(e)))}><PlaneLanding size={18} /></IconButton>
        </div>
        <label className="search"><Search size={16} /><input value={q} onChange={e => setQ(e.target.value)} placeholder="Поиск: стоянка, борт, инженер" /></label>
        <nav className="tabs">
          <TabBtn on={tab === 'requests'} onClick={() => onTab('requests')} icon={<ClipboardList size={15} />} label="Заявки" count={state.active.length} />
          <TabBtn on={tab === 'flights'} onClick={() => onTab('flights')} icon={<Plane size={15} />} label="Рейсы" count={state.aircraft.length} />
          <TabBtn on={tab === 'team'} onClick={() => onTab('team')} icon={<Users size={15} />} label="Команда" count={regCount || undefined} alert={regCount > 0} />
          <TabBtn on={tab === 'log'} onClick={() => onTab('log')} icon={<ScrollText size={15} />} label="Журнал" />
        </nav>
      </header>
      <div className="queue-body">
        {tab === 'requests' && (requests.length
          ? requests.map(r => <RequestCard key={r.id} r={r} selected={selected.request === r.id} onClick={() => onSelectRequest(r.id)} />)
          : <Empty icon={<Inbox size={22} />} title={query ? 'Ничего не найдено' : 'Активных заявок нет'} text={query ? undefined : 'Создайте заявку или нажмите на стоянку на карте.'} />)}
        {tab === 'flights' && <Flights state={state} match={match} selected={selected.aircraft} onSelect={onSelectAircraft} />}
        {tab === 'team' && <Team state={state} match={match} selected={selected.tech} onSelect={onSelectTech} />}
        {tab === 'log' && <Log state={state} />}
      </div>
    </aside>
  );
}

const prio = (r: Request) => (r.priority === 'emergency' ? 100 : 0) + (r.status === 'waiting' ? 10 : 0) + (r.elapsed > 720 ? 5 : 0);

function TabBtn({ on, onClick, icon, label, count, alert }: { on: boolean; onClick(): void; icon: React.ReactNode; label: string; count?: number; alert?: boolean }) {
  return <button className={cx(on && 'on')} onClick={onClick}>{icon}<span>{label}</span>{count ? <em className={cx(alert && 'alert')}>{count}</em> : null}</button>;
}

function RequestCard({ r, selected, onClick }: { r: Request; selected: boolean; onClick(): void }) {
  const em = r.priority === 'emergency';
  return (
    <article className={cx('req', `st-${r.status}`, em && 'em', selected && 'sel', r.violation && 'late')} onClick={onClick}>
      <header>
        <span className="req-stand">{r.stand}</span>
        {r.flight && <span className="req-flight">{r.flight}</span>}
        <span className="req-qual" style={{ '--q': qualColor(r.qual) } as React.CSSProperties}>{r.qual}</span>
        <StatusPill r={r} />
      </header>
      <p className="req-desc">{r.description}</p>
      <dl className="req-kv">
        <div><dt>Инженер</dt><dd className="sans">{r.tech_name || '—'}</dd></div>
        <div><dt>До прибытия</dt><dd><Countdown r={r} /></dd></div>
        <div><dt>С вызова</dt><dd className={cx(r.elapsed > 900 && 't-red')}>{mmss(r.elapsed)}</dd></div>
      </dl>
      <SlaBar r={r} />
    </article>
  );
}

function Flights({ state, match, selected, onSelect }: { state: ShiftState; match(...f: (string | null | undefined)[]): boolean; selected: number | null; onSelect(id: number): void }) {
  const list = state.aircraft.filter(a => match(a.flight, a.model, a.stand, a.brief?.airline, a.brief?.origin?.iata));
  if (!list.length) return <Empty icon={<Plane size={22} />} title="Рейсов нет" text="Борта прилетают автоматически или по кнопке «Добавить рейс»." />;
  return <div className="board">{list.map(a => <FlightRow key={a.id} a={a} selected={selected === a.id} onClick={() => onSelect(a.id)} />)}</div>;
}

function FlightRow({ a, selected, onClick }: { a: Aircraft; selected: boolean; onClick(): void }) {
  const delayed = (a.delay_arr_sec || 0) > 60;
  return (
    <button className={cx('flight', selected && 'sel')} onClick={onClick}>
      <span className="flight-time"><b>{simClock(a.actual_arr_sim ?? a.sched_arr_sim)}</b>{delayed && <em>+{Math.round((a.delay_arr_sec || 0) / 60)}м</em>}</span>
      <span className="flight-main">
        <b>{a.flight}<small>{a.brief?.airline}</small></b>
        <span>{a.brief?.origin?.iata || '—'} → {a.brief?.destination?.iata || 'SVO'} · {a.model}{a.stand ? ` · ${a.stand}` : ''}</span>
        {a.status === 'parked' && <i className="turn"><i style={{ transform: `scaleX(${(a.services_progress || 0) / 100})` }} /></i>}
      </span>
      <span className={cx('pill', a.status === 'inbound' ? 'pill-accent' : a.status === 'departing' ? 'pill-amber' : 'pill-green')}>{a.status_ru}</span>
    </button>
  );
}

function Team({ state, match, selected, onSelect }: { state: ShiftState; match(...f: (string | null | undefined)[]): boolean; selected: number | null; onSelect(id: number): void }) {
  const regs = state.registrations || [];
  const techs = state.techs.filter(t => match(t.name, t.qual, ...(t.types || [])));
  const free = techs.filter(t => t.on_shift && t.status === 'free').length;
  return (
    <>
      {regs.length > 0 && (
        <section className="team-section">
          <h4>Заявки на доступ · {regs.length}</h4>
          {regs.map(u => <Registration key={u.id} u={u} />)}
        </section>
      )}
      <section className="team-section">
        <h4>Инженеры · {free} свободно из {techs.length}</h4>
        {techs.map(t => <TechRow key={t.id} t={t} selected={selected === t.id} onClick={() => onSelect(t.id)} />)}
      </section>
    </>
  );
}

function TechRow({ t, selected, onClick }: { t: Technician; selected: boolean; onClick(): void }) {
  const contact = useTechContact(t.id);
  const online = useChat(s => (contact ? s.online.has(contact.id) : false));
  return (
    <div className={cx('trow', selected && 'sel', !t.on_shift && 'off')} onClick={onClick}>
      <Avatar name={t.name} color={contact?.avatar_color || qualColor(t.qual)} size={36} online={contact ? online : undefined} />
      <div className="trow-main">
        <b>{t.name}</b>
        <span><i className="dot" style={{ background: qualColor(t.qual) }} />{t.qual} · {(t.types || []).join(', ') || 'все типы'}</span>
      </div>
      <div className="trow-side">
        <span className={cx('pill', !t.on_shift ? 'pill-muted' : t.status === 'free' ? 'pill-green' : 'pill-accent')}>{!t.on_shift ? 'не на смене' : t.status === 'free' ? 'свободен' : `заявка #${t.request_id}`}</span>
        {contact && (
          <span className="trow-acts" onClick={e => e.stopPropagation()}>
            <IconButton label="Написать" onClick={() => messageUser(contact.id)}><MessageSquare size={15} /></IconButton>
            <IconButton label="Позвонить" onClick={() => callUser(contact.id, contact.name)}><Phone size={15} /></IconButton>
          </span>
        )}
      </div>
    </div>
  );
}

function Registration({ u }: { u: User }) {
  const [busy, setBusy] = useState(false);
  const run = (fn: () => Promise<unknown>, ok: string) => { setBusy(true); fn().then(() => toast.ok(ok)).catch(e => toast.bad(errorText(e))).finally(() => setBusy(false)); };
  return (
    <article className="reg">
      <Avatar name={u.name} color={u.avatar_color} size={38} />
      <div className="reg-main">
        <b>{u.name} <small>@{u.username}</small></b>
        <span>{u.qual} · {(u.types || []).join(', ') || 'без допусков'}</span>
        <span className="muted">{u.email} · {timeHM(u.created_at)}</span>
      </div>
      <div className="reg-acts">
        <Button size="sm" variant="success" icon={<UserCheck size={15} />} loading={busy} onClick={() => run(() => act.approve(u.id), `${u.name} допущен к смене`)}>Допустить</Button>
        <Button size="sm" variant="danger" icon={<UserX size={15} />} disabled={busy} onClick={() => run(() => act.reject(u.id), 'Заявка отклонена')} />
      </div>
    </article>
  );
}

function Log({ state }: { state: ShiftState }) {
  const events = [...state.events].reverse();
  return (
    <div className="log">
      {events.length ? events.map((e, i) => (
        <div key={i} className={cx('ev', e.kind)}><time>{timeHM(e.ts) || e.ts}</time><span>{e.text}</span></div>
      )) : <Empty icon={<ScrollText size={22} />} title="Журнал пуст" text="Здесь появятся события смены." />}
    </div>
  );
}
