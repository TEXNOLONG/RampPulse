import { apiUrl } from '../../lib/api';
import { useState } from 'react';
import { X, Phone, MessageSquare, MapPin, Check, Play, Flag, Ban, Timer, Footprints, Car, PlaneTakeoff, Plus, Move, Save, Wrench } from 'lucide-react';
import type { Aircraft, Request, Technician } from '../../lib/types';
import { useOps, act } from '../../store/ops';
import { useChat } from '../../store/chat';
import { Avatar, Button, IconButton, toast } from '../../components/ui';
import { cx, mmss, qualColor, simClock } from '../../lib/format';
import { errorText } from '../../lib/api';
import { NORM, StatusPill, callUser, messageUser, useTechContact } from './shared';

const AIRCRAFT_TYPES = ['A320', 'A321', 'A330', 'A350', 'B737', 'B777', 'B787', 'SSJ-100', 'MC-21'];

function PanelHead({ eyebrow, title, sub, onClose, children }: { eyebrow: string; title: React.ReactNode; sub?: React.ReactNode; onClose(): void; children?: React.ReactNode }) {
  return (
    <header className="panel-head">
      <div className="panel-head-top"><span className="eyebrow">{eyebrow}</span><IconButton label="Закрыть" onClick={onClose}><X size={18} /></IconButton></div>
      <h2>{title}</h2>
      {sub && <div className="panel-sub">{sub}</div>}
      {children}
    </header>
  );
}

const run = (p: Promise<unknown>, ok?: string) => p.then(() => ok && toast.ok(ok)).catch(e => toast.bad(errorText(e)));

export function RequestDetail({ r, onClose, onTech }: { r: Request; onClose(): void; onTech(id: number): void }) {
  const contact = useTechContact(r.tech_id);
  const online = useChat(s => (contact ? s.online.has(contact.id) : false));
  const [busy, setBusy] = useState<string | null>(null);
  const step = (s: 'arrive' | 'start' | 'resolve' | 'cancel', ok: string) => { setBusy(s); run(act.dispatcherStep(r.id, s), ok).finally(() => setBusy(null)); };
  const next = { enroute: ['arrive', 'Инженер прибыл', Check], assigned: ['arrive', 'Инженер прибыл', Check], arrived: ['start', 'Начать работу', Play], working: ['resolve', 'Работа выполнена', Flag] }[r.status as string] as [any, string, any] | undefined;
  const NextIcon = next?.[2];
  const elapsed = r.arrived_sim != null ? r.arrived_sim - r.created_sim : r.elapsed;
  const pct = Math.min(1, elapsed / NORM);
  const arrived = ['arrived', 'working', 'done'].includes(r.status);
  const steps = [
    { label: 'Заявка создана', sub: r.stand, time: simClock(r.created_sim), state: 'done' },
    { label: r.tech_id ? 'Назначен инженер' : 'Ожидает инженера', sub: r.tech_name || 'нет свободного специалиста с допуском', time: r.tech_id ? simClock(r.created_sim) : '', state: r.tech_id ? 'done' : 'now' },
    { label: 'Прибытие на стоянку', sub: arrived ? `через ${mmss(elapsed)}` : r.eta_left != null ? `расчёт ${mmss(r.eta_left)}` : 'ожидается', time: r.arrived_sim != null ? simClock(r.arrived_sim) : '', state: arrived ? 'done' : r.tech_id ? 'now' : '' },
    { label: 'Работа', sub: r.status === 'working' ? 'дефект устраняется' : 'после прибытия', time: '', state: r.status === 'working' ? 'now' : r.status === 'done' ? 'done' : '' },
    { label: 'Заявка закрыта', sub: '', time: r.done_sim != null ? simClock(r.done_sim) : '', state: r.status === 'done' ? 'done' : '' },
  ];
  const candidates = (r.candidates || []).slice().sort((a, b) => (a.eta ?? 1e9) - (b.eta ?? 1e9));

  return (
    <div className="panel-scroll">
      <PanelHead eyebrow={`Заявка #${r.id}${r.flight ? ` · ${r.flight}` : ''}`} title={<span className="mono">{r.stand}</span>} onClose={onClose} sub={<><StatusPill r={r} /><span className="req-qual" style={{ '--q': qualColor(r.qual) } as React.CSSProperties}>{r.qual}</span></>}>
        <div className={cx('sla-ring', pct >= 1 ? 'red' : pct >= .8 ? 'amber' : arrived ? 'green' : 'accent')}>
          <svg viewBox="0 0 120 120"><circle cx="60" cy="60" r="52" className="track" /><circle cx="60" cy="60" r="52" className="value" style={{ strokeDashoffset: 327 * (1 - pct) }} /></svg>
          <div><b>{mmss(elapsed)}</b><span>из 15:00</span></div>
        </div>
      </PanelHead>

      <section className="panel-sec">
        <h3>Дефект</h3>
        <p className="lead">{r.description}</p>
        {r.extra && <p className="muted">{r.extra}</p>}
        {r.note && <p className="note"><Wrench size={14} />{r.note}</p>}
      </section>

      <section className="panel-sec">
        <h3>Исполнитель</h3>
        {r.tech_id ? (
          <div className="person-card">
            <Avatar name={r.tech_name} color={contact?.avatar_color || qualColor(r.qual)} src={contact ? apiUrl(`/api/profile/media/${contact.id}/avatar`) : undefined} size={44} online={contact ? online : undefined} />
            <div className="person-main" onClick={() => onTech(r.tech_id!)}>
              <b>{r.tech_name}</b>
              <span>{r.travel_mode === 'vehicle' ? <><Car size={13} /> на машине</> : <><Footprints size={13} /> пешком</>} · расчёт {mmss(r.eta)}</span>
            </div>
            <div className="person-acts">
              <IconButton label="Написать инженеру" disabled={!contact} onClick={() => contact && messageUser(contact.id)}><MessageSquare size={18} /></IconButton>
              <IconButton label="Позвонить инженеру" className="call" disabled={!contact} onClick={() => callUser(contact?.id, r.tech_name || 'Инженер')}><Phone size={18} /></IconButton>
            </div>
          </div>
        ) : <p className="callout amber">Свободного инженера с допуском «{r.qual}» нет. Заявка в очереди — назначение произойдёт автоматически.</p>}
      </section>

      {candidates.length > 0 && (
        <section className="panel-sec">
          <h3>Почему выбран этот инженер</h3>
          <div className="cands">
            {candidates.map(c => {
              const pick = c.tech_id === r.tech_id;
              const ok = c.eta != null && c.eta <= NORM;
              return (
                <div key={c.tech_id} className={cx('cand', pick && 'pick')}>
                  <span className="cand-name">{c.name}</span>
                  <span className={cx('cand-eta', ok ? 't-green' : 't-red')}>{mmss(c.eta)}</span>
                  <span className="cand-bar"><i style={{ transform: `scaleX(${Math.min(1, (c.eta ?? NORM * 1.5) / (NORM * 1.5))})` }} className={ok ? 'ok' : 'bad'} /><em style={{ left: `${(1 / 1.5) * 100}%` }} /></span>
                  <small>{c.reason || (ok ? 'успевает' : 'не успевает в норматив')}</small>
                </div>
              );
            })}
          </div>
        </section>
      )}

      <section className="panel-sec">
        <h3>Ход работы</h3>
        <ol className="timeline">
          {steps.map((s, i) => (
            <li key={i} className={s.state}><span className="tl-dot">{s.state === 'done' ? <Check size={13} strokeWidth={3} /> : i + 1}</span><div><b>{s.label}</b>{s.sub && <span>{s.sub}</span>}</div><time>{s.time}</time></li>
          ))}
        </ol>
      </section>

      <footer className="panel-actions">
        {next && <Button variant="primary" size="lg" icon={NextIcon ? <NextIcon size={18} /> : undefined} loading={busy === next[0]} onClick={() => step(next[0], 'Статус обновлён')}>{next[1]}</Button>}
        <Button variant="danger" size="lg" icon={<Ban size={17} />} loading={busy === 'cancel'} onClick={() => step('cancel', 'Заявка отменена')}>Отменить</Button>
      </footer>
    </div>
  );
}


export function TechDetail({ t, onClose, onMove }: { t: Technician; onClose(): void; onMove(id: number): void }) {
  const contact = useTechContact(t.id);
  const online = useChat(s => (contact ? s.online.has(contact.id) : false));
  const state = useOps(s => s.state)!;
  const [qual, setQual] = useState(t.qual);
  const [types, setTypes] = useState<string[]>(t.types || []);
  const busy = t.status !== 'free';
  const req = t.request_id ? state.active.find(r => r.id === t.request_id) : null;
  return (
    <div className="panel-scroll">
      <PanelHead eyebrow="Сотрудник смены" onClose={onClose} title={t.name} sub={<><span className={cx('pill', !t.on_shift ? 'pill-muted' : busy ? 'pill-accent' : 'pill-green')}>{!t.on_shift ? 'не на смене' : busy ? 'на заявке' : 'свободен'}</span>{contact && <span className={cx('pill', online ? 'pill-green' : 'pill-muted')}>{online ? 'в сети' : 'не в сети'}</span>}</>}>
        <div className="profile-hero">
          <Avatar name={t.name} color={contact?.avatar_color || qualColor(t.qual)} src={contact ? apiUrl(`/api/profile/media/${contact.id}/avatar`) : undefined} size={64} online={contact ? online : undefined} />
          {contact && <p className="muted">@{contact.username}{contact.bio ? ` · ${contact.bio}` : ''}</p>}
          {contact && <div className="hero-acts"><Button icon={<MessageSquare size={16} />} onClick={() => messageUser(contact.id)}>Написать</Button><Button variant="success" icon={<Phone size={16} />} onClick={() => callUser(contact.id, t.name)}>Позвонить</Button></div>}
        </div>
      </PanelHead>
      <section className="panel-sec">
        <div className="facts">
          <div><span>Квалификация</span><b style={{ color: qualColor(t.qual) }}>{t.qual}</b></div>
          <div><span>Скорость</span><b>{t.speed} м/с</b></div>
          <div><span>База</span><b>{t.base}</b></div>
          <div><span>Допуски</span><b>{(t.types || []).join(', ') || '—'}</b></div>
        </div>
        {req && <p className="callout"><MapPin size={14} />Заявка #{req.id} · {req.stand} · {req.description}</p>}
      </section>
      <section className="panel-sec">
        <h3>Профиль допуска (симуляция)</h3>
        <div className="seg-row">{['Планер', 'Двигатель', 'Авионика'].map(q => <button key={q} disabled={busy} className={cx('chip', qual === q && 'on')} onClick={() => setQual(q)}>{q}</button>)}</div>
        <div className="chips">{AIRCRAFT_TYPES.map(x => <button key={x} disabled={busy} className={cx('chip', types.includes(x) && 'on')} onClick={() => setTypes(v => v.includes(x) ? v.filter(y => y !== x) : [...v, x])}>{x}</button>)}</div>
        <div className="row-2">
          <Button icon={<Save size={16} />} disabled={busy} onClick={() => run(act.techProfile(t.id, qual, types), 'Профиль обновлён')}>Сохранить</Button>
          <Button icon={<Move size={16} />} disabled={busy} onClick={() => onMove(t.id)}>Переместить</Button>
        </div>
      </section>
    </div>
  );
}

export function AircraftDetail({ a, onClose, onRequest }: { a: Aircraft; onClose(): void; onRequest(stand: string): void }) {
  const state = useOps(s => s.state)!;
  const reqs = state.active.filter(r => r.stand === a.stand);
  const b = a.brief || {};
  return (
    <div className="panel-scroll">
      <PanelHead eyebrow={`${b.airline || 'Рейс'} · ${b.registration || a.model}`} title={<span className="mono">{a.flight}</span>} onClose={onClose} sub={<><span className={cx('pill', a.status === 'parked' ? 'pill-green' : 'pill-accent')}>{a.status_ru}</span><span className="pill pill-muted">{a.model}</span></>}>
        <div className="route-card">
          <div><b>{b.origin?.iata || '—'}</b><span>{b.origin?.name}</span></div>
          <PlaneTakeoff size={20} />
          <div><b>{b.destination?.iata || 'SVO'}</b><span>{b.destination?.name}</span></div>
        </div>
      </PanelHead>
      <section className="panel-sec">
        <div className="facts">
          <div><span>Стоянка</span><b>{a.stand || '—'}</b></div>
          <div><span>Выход</span><b>{b.gate || '—'}</b></div>
          <div><span>Прибытие</span><b>{simClock(a.actual_arr_sim ?? a.sched_arr_sim)}</b></div>
          <div><span>Вылет</span><b>{simClock(a.sched_dep_sim)}</b></div>
        </div>
        {a.status === 'parked' && <div className="progress-line"><span>Обслуживание</span><i><i style={{ transform: `scaleX(${(a.services_progress || 0) / 100})` }} /></i><b>{a.services_progress || 0}%</b></div>}
      </section>
      <section className="panel-sec">
        <h3>Заявки по борту</h3>
        {reqs.length ? reqs.map(r => <p key={r.id} className="callout"><Timer size={14} />#{r.id} · {r.description} · {r.status_ru}</p>) : <p className="muted">Открытых заявок нет.</p>}
      </section>
      <footer className="panel-actions">
        {a.stand && <Button variant="primary" size="lg" icon={<Plus size={18} />} onClick={() => onRequest(a.stand!)}>Заявка на борт</Button>}
        {a.status === 'parked' && <Button size="lg" icon={<PlaneTakeoff size={17} />} onClick={() => run(act.depart(a.id), 'Борт отправлен')}>Отправить</Button>}
      </footer>
    </div>
  );
}
