import { routeInstruction } from '../../lib/navigation';
import { apiUrl } from '../../lib/api';
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { ClipboardList, Map as MapIcon, MessageCircle, UserRound, Phone, MessageSquare, LifeBuoy, Clock, Check, Flag, MapPin, Plane, Navigation, Power, Wifi, WifiOff, Coffee, Footprints, Car, ListChecks, FileText, ChevronRight, Timer } from 'lucide-react';
import { useOps, act } from '../../store/ops';
import { useChat, useUnreadTotal } from '../../store/chat';
import { useCall } from '../../store/call';
import { ChatView } from '../chat/ChatView';
import { SettingsModal } from '../settings/SettingsModal';
import { Avatar, Button, Modal, toast } from '../../components/ui';
import { Logo } from '../../components/BootScreen';
import { cx, mmss, qualColor, simClock } from '../../lib/format';
import { errorText } from '../../lib/api';
import { post } from '../../lib/api';
import { useGps } from '../../lib/gps';
import type { Request } from '../../lib/types';

type Tab = 'task' | 'map' | 'chat' | 'profile';
const GeoMap = lazy(() => import('../map/GeoMap').then(module => ({ default: module.GeoMap })));
const NORM = 900;

const CHECKLISTS: Record<string, string[]> = {
  'Планер': ['Внешний осмотр зоны дефекта', 'Проверка крепежа и обшивки', 'Осмотр шасси и тормозов', 'Проверка гидросистемы на подтекания', 'Запись в бортовой журнал'],
  'Двигатель': ['Осмотр воздухозаборника и лопаток', 'Проверка уровня масла', 'Осмотр капотов и креплений', 'Проверка параметров на запуске', 'Запись в бортовой журнал'],
  'Авионика': ['Чтение кодов неисправностей', 'Проверка разъёмов и блоков', 'Тест радиосвязи и навигации', 'Перезагрузка / замена блока', 'Запись в бортовой журнал'],
};

export function EngineerApp() {
  const state = useOps(s => s.state)!;
  const me = useOps(s => s.me)!;
  const online = useOps(s => s.online);
  const airport = useOps(s => s.airport)!;
  const unread = useUnreadTotal();
  const [tab, setTab] = useState<Tab>('task');
  const [sharingLocation, setSharingLocation] = useState(false);
  const [locationShareError, setLocationShareError] = useState<string | null>(null);
  const gpsStatus = useGps(s => s.status);
  const gpsFix = useGps(s => s.raw);
  const task = state.active[0] ?? null;
  const navigationHint = useMemo(() => {
    const tech = state.techs.find(t => t.id === task?.tech_id);
    if (!tech || !task || !['assigned', 'enroute'].includes(task.status)) return null;
    if (tech.route_available === false) return {text:'Маршрут недоступен — свяжитесь с диспетчером',remaining:0,turn:'unavailable'};
    if (!tech.route.length) return {text:'Рассчитываем маршрут…',remaining:0,turn:'loading'};
    return routeInstruction([tech.x, tech.y], tech.route);
  }, [state.techs, task?.tech_id, task?.status]);
  useEffect(() => {
    let stopped = false;
    let timer = 0;
    const refresh = async () => {
      if (document.visibilityState === 'visible') await useOps.getState().reload();
      if (!stopped) timer = window.setTimeout(refresh, 2000);
    };
    void refresh();
    return () => { stopped = true; window.clearTimeout(timer); };
  }, []);
  const lastNotifiedTask = useRef<number | null>(null);
  const [newTaskId, setNewTaskId] = useState<number | null>(null);
  useEffect(() => {
    if (!task) { lastNotifiedTask.current = null; return; }
    if (lastNotifiedTask.current === task.id) return;
    lastNotifiedTask.current = task.id;
    if (task.status === 'assigned' || task.status === 'enroute') {
      setNewTaskId(task.id);
      navigator.vibrate?.([200, 100, 200]);
    }
  }, [task?.id, task?.status]);

  useEffect(() => { useChat.getState().setOpen(tab === 'chat'); }, [tab]);
  const onShift = state.account?.on_shift ?? me.on_shift;
  useEffect(() => {
    if (!sharingLocation || !onShift) {
      if (!onShift && sharingLocation) setSharingLocation(false);
      return;
    }
    useGps.getState().start();
    useGps.getState().setFollow(true);
    let lastSent = 0;
    const send = () => {
      const fix = useGps.getState().raw;
      if (!fix || Date.now() - fix.timestamp > 30_000 || fix.timestamp <= lastSent) return;
      lastSent = fix.timestamp;
      void post('/api/engineer/location', { enabled: true, observed_ms: fix.timestamp, latitude: fix.latitude, longitude: fix.longitude, accuracy: fix.accuracy, heading: fix.heading, speed: fix.speed })
        .then(() => setLocationShareError(null)).catch(error => setLocationShareError(errorText(error)));
    };
    send();
    const timer = window.setInterval(send, 5_000);
    return () => {
      window.clearInterval(timer);
      void post('/api/engineer/location', { enabled: false }).catch(() => undefined);
      useGps.getState().stop();
    };
  }, [sharingLocation, onShift]);

  return (
    <div className="eng">
      <Modal open={newTaskId != null && newTaskId === task?.id && ['assigned', 'enroute'].includes(task?.status ?? '')} onClose={() => setNewTaskId(null)} title="У вас новая заявка">
        <p>{task?.stand} · {task?.description}</p>
        <p className="muted">Диспетчер назначил вас исполнителем. Маршрут рассчитывается по дорогам ВДНХ.</p>
        <Button onClick={() => { setNewTaskId(null); setTab('task'); }}>Посмотреть заявку</Button>
      </Modal>
      <header className="eng-bar">
        <Logo size={32} />
        <div className="eng-bar-title"><b>{me.name}</b><span>{me.qual} · {state.airport_name}</span></div>
        <span className={cx('conn-chip', online ? 'on' : 'off')}>{online ? <Wifi size={14} /> : <WifiOff size={14} />}<span>{online ? 'онлайн' : 'нет связи'}</span></span>
      </header>

      <main className="eng-main">
        {tab === 'task' && <>{navigationHint && <button className="engineer-navigation" onClick={() => setTab('map')}><Navigation size={24}/><span><b>{navigationHint.text}</b><small>{task?.travel_mode === 'vehicle' ? 'Спецтранспорт' : 'Пешком'} · осталось {Math.round(navigationHint.remaining)} м · {mmss(task?.eta_left)}</small></span><ChevronRight size={18}/></button>}<TaskTab task={task} onMap={() => setTab('map')} onChat={() => setTab('chat')} /></>}
        {tab === 'map' && (
          <div className="eng-map">
            <Suspense fallback={<div className="geo-map-loading glass">Загрузка карты…</div>}><GeoMap airport={airport} simulated={state.aircraft} simulatedTechs={state.techs} requests={state.active} importedAirport panelOpen={false} manageGps={false} /></Suspense>
            <button className={cx('location-share-icon', sharingLocation && 'on', locationShareError && 'error')} aria-pressed={sharingLocation} aria-label={sharingLocation ? 'Остановить передачу геопозиции диспетчеру' : 'Поделиться геопозицией с диспетчером'} title={locationShareError || (sharingLocation ? gpsFix ? 'Геопозиция передаётся' : `GPS: ${gpsStatus}` : onShift ? 'Поделиться геопозицией' : 'Начните смену для передачи геопозиции')} disabled={!onShift && !sharingLocation} onClick={() => { setSharingLocation(value => !value); if (!sharingLocation) toast.info('Передача геопозиции включена. Ожидаем координаты GPS.'); }}><Navigation size={21} /><i /></button>
            {task && <div className="map-task glass"><MapPin size={16} /><div><b>{navigationHint?.text || task.stand}</b><span>{task.status === 'enroute' ? `${task.travel_mode === 'vehicle' ? 'Спецтранспорт' : 'Пешком'} · ${Math.round(navigationHint?.remaining ?? 0)} м · ${mmss(task.eta_left)} · ${(state.techs.find(t => t.id === task.tech_id)?.speed_kmh ?? 0).toFixed(1)} км/ч` : task.status_ru}</span></div></div>}
          </div>
        )}
        {tab === 'chat' && <div className="eng-chat"><ChatView /></div>}
        {tab === 'profile' && <ProfileTab />}
      </main>

      <nav className="tabbar">
        <TabBtn on={tab === 'task'} onClick={() => setTab('task')} icon={<ClipboardList size={22} />} label="Задача" dot={!!task} />
        <TabBtn on={tab === 'map'} onClick={() => setTab('map')} icon={<MapIcon size={22} />} label="Карта" />
        <TabBtn on={tab === 'chat'} onClick={() => setTab('chat')} icon={<MessageCircle size={22} />} label="Связь" badge={unread} />
        <TabBtn on={tab === 'profile'} onClick={() => setTab('profile')} icon={<UserRound size={22} />} label="Профиль" />
      </nav>
    </div>
  );
}

function TabBtn({ on, onClick, icon, label, badge, dot }: { on: boolean; onClick(): void; icon: React.ReactNode; label: string; badge?: number; dot?: boolean }) {
  return <button className={cx(on && 'on')} onClick={onClick}><span className="tb-icon">{icon}{badge ? <em>{badge}</em> : dot ? <i /> : null}</span><small>{label}</small></button>;
}

function useDispatcher() {
  return useChat(s => {
    const list = s.contacts.filter(c => c.on_shift || s.online.has(c.id));
    return list.find(c => s.online.has(c.id)) ?? list[0] ?? s.contacts[0] ?? null;
  });
}

function TaskTab({ task, onMap, onChat }: { task: Request | null; onMap(): void; onChat(): void }) {
  const state = useOps(s => s.state)!;
  const me = useOps(s => s.me)!;
  const onShift = state.account?.on_shift ?? me.on_shift;
  const [shiftDlg, setShiftDlg] = useState(false);
  const done = state.history.length;
  const times = state.history.filter(r => r.arrived_sim != null).map(r => (r.response_sec ?? r.elapsed));
  const avg = times.length ? times.reduce((a, b) => a + b, 0) / times.length : null;
  const sla = times.length ? Math.round(times.filter(t => t <= NORM).length / times.length * 100) : null;

  return (
    <div className="eng-scroll">
      <div className="shift-card">
        <div className={cx('shift-state', onShift ? 'on' : 'off')}><Power size={18} /><div><b>{onShift ? 'На смене' : 'Не на смене'}</b><span>{onShift ? 'Заявки назначаются автоматически' : 'Выйдите на смену, чтобы получать заявки'}</span></div></div>
        {onShift
          ? <Button variant="ghost" onClick={() => setShiftDlg(true)}>Завершить</Button>
          : <Button variant="success" onClick={() => act.shiftStart().then(() => { toast.ok('Вы на смене'); useOps.getState().reload(); }).catch(e => toast.bad(errorText(e)))}>Выйти на смену</Button>}
      </div>

      {task ? <TaskCard r={task} onMap={onMap} onChat={onChat} /> : (
        <div className="free-card">
          <span className="free-icon"><Coffee size={26} /></span>
          <b>{onShift ? 'Вы свободны' : 'Смена не начата'}</b>
          <p>{onShift ? 'Как только появится заявка по вашей квалификации и допускам, она откроется здесь со звуковым сигналом.' : 'После выхода на смену вы появитесь на карте диспетчера.'}</p>
        </div>
      )}

      <div className="eng-stats">
        <div><b>{done}</b><span>выполнено</span></div>
        <div><b className="t-green">{sla == null ? '—' : `${sla}%`}</b><span>в нормативе</span></div>
        <div><b>{avg == null ? '—' : mmss(avg)}</b><span>ср. прибытие</span></div>
      </div>

      <section className="eng-section">
        <h3>История смены</h3>
        {state.history.length ? [...state.history].reverse().slice(0, 12).map(r => (
          <div key={r.id} className="hist"><span className="mono">{r.stand}</span><div><b>{r.description}</b><span>{simClock(r.created_sim)} · прибытие {r.arrived_sim != null ? mmss(r.response_sec ?? r.elapsed) : '—'}</span></div><Check size={16} className="t-green" /></div>
        )) : <p className="muted">Закрытых заявок пока нет.</p>}
      </section>

      <Modal open={shiftDlg} onClose={() => setShiftDlg(false)} eyebrow="Управление сменой" title="Завершить смену?"
        footer={<><Button onClick={() => setShiftDlg(false)}>Остаться</Button><Button variant="danger" onClick={() => act.shiftEnd().then(() => { setShiftDlg(false); toast.ok('Смена завершена'); useOps.getState().reload(); }).catch(e => toast.bad(errorText(e), 'Нельзя завершить смену'))}>Завершить</Button></>}>
        <p className="muted">{task ? 'На вас назначена активная заявка — сначала закройте её или попросите диспетчера переназначить.' : 'Вы перестанете получать новые заявки и пропадёте с карты диспетчера.'}</p>
      </Modal>
    </div>
  );
}

function TaskCard({ r, onMap, onChat }: { r: Request; onMap(): void; onChat(): void }) {
  const state = useOps(s => s.state)!;
  const dispatcher = useDispatcher();
  const technician = state.techs.find(t => t.id === r.tech_id);
  const callPhase = useCall(s => s.phase);
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState(false);
  const [declining, setDeclining] = useState(false);
  const [declineReason, setDeclineReason] = useState('');
  const [declineBusy, setDeclineBusy] = useState(false);
  const aircraft = state.aircraft.find(a => a.id === r.aircraft_id || (a.stand === r.stand && a.status === 'parked'));
  const elapsed = r.response_sec ?? r.elapsed;
  const pct = Math.min(1, elapsed / NORM);
  const em = r.priority === 'emergency';
  const stepIdx = ({ assigned: 1, enroute: 1, arrived: 2, working: 3 } as Record<string, number>)[r.status] ?? 0;
  const next = ({ working: ['resolve', 'Работа выполнена', Flag] } as Record<string, [string, string, any]>)[r.status];
  const checkKey = `rp.check.${r.id}`;
  const items = CHECKLISTS[r.qual] ?? CHECKLISTS['Планер'];
  const [checked, setChecked] = useState<number[]>(() => { try { return JSON.parse(localStorage.getItem(checkKey) || '[]'); } catch { return []; } });
  useEffect(() => { try { localStorage.setItem(checkKey, JSON.stringify(checked)); } catch { /* ignore */ } }, [checked, checkKey]);

  useEffect(() => { // new assignment alert
    if (r.status === 'enroute' || r.status === 'assigned') navigator.vibrate?.([200, 100, 200]);
  }, [r.id]);

  async function advance() {
    if (!next) return;
    if (next[0] === 'resolve') { setReport(true); return; }
    setBusy(true);
    try { if (next[0] === 'accept') await act.acceptRequest(r.id); else await act.engineerStep(r.id, next[0] as any); toast.ok(next[0] === 'arrive' ? 'Прибытие отмечено' : 'Работа начата'); await useOps.getState().reload(); }
    catch (e) { toast.bad(errorText(e)); }
    finally { setBusy(false); }
  }

  async function decline() {
    const reason = declineReason.trim();
    if (reason.length < 3) { toast.bad('Укажите причину отказа'); return; }
    setDeclineBusy(true);
    try {
      await act.declineRequest(r.id, reason);
      setDeclining(false);
      toast.ok('Заявка возвращена диспетчеру');
      await useOps.getState().reload();
    } catch (e) { toast.bad(errorText(e)); }
    finally { setDeclineBusy(false); }
  }

  async function quick(sticker: string, text: string) {
    const chat = useChat.getState();
    const shift = chat.rooms.find(x => x.kind === 'shift');
    if (shift) { await chat.openRoom(shift.id); await chat.sendSticker(sticker); await chat.sendText(`${text} · заявка #${r.id}, ${r.stand}`); toast.ok('Смена оповещена'); }
  }

  return (
    <article className={cx('task', em && 'em')}>
      <header className="task-head">
        <div>
          <span className="eyebrow">{em ? 'Чрезвычайная ситуация' : `Заявка #${r.id}`}</span>
          <h2 className="mono">{r.stand}</h2>
          <span className="task-sub"><Plane size={14} />{r.flight || aircraft?.flight || 'борт'} · {aircraft?.model || 'ВС'} <span className="dot" style={{ background: qualColor(r.qual) }} />{r.qual}</span>
        </div>
        <div className={cx('ring', pct >= 1 ? 'red' : pct >= .8 ? 'amber' : stepIdx >= 2 ? 'green' : 'accent')}>
          <svg viewBox="0 0 120 120"><circle cx="60" cy="60" r="52" className="track" /><circle cx="60" cy="60" r="52" className="value" style={{ strokeDashoffset: 327 * (1 - pct) }} /></svg>
          <div><b className="mono">{stepIdx >= 2 ? mmss(elapsed) : mmss(Math.max(0, NORM - r.elapsed))}</b><span>{stepIdx >= 2 ? 'прибыл за' : 'до норматива'}</span></div>
        </div>
      </header>

      <p className="task-desc">{r.description}</p>
      {r.extra && <p className="muted small">{r.extra}</p>}

      <div className="task-facts">
        <div><span>Скорость движения</span><b>{(technician?.speed_kmh ?? 0).toFixed(1)} км/ч</b></div>
        <div><span>Лимит участка</span><b>{technician?.speed_limit_kmh == null ? "—" : `${technician.speed_limit_kmh.toFixed(0)} км/ч`}</b></div>
        <div><span>{r.status === 'enroute' ? 'Прибытие через' : 'Статус'}</span><b className="mono">{r.status === 'enroute' ? mmss(r.eta_left) : r.status_ru}</b></div>
        <div><span>Как добираться</span><b>{r.travel_mode === 'vehicle' ? <><Car size={14} />машина</> : <><Footprints size={14} />пешком</>}</b></div>
        <div><span>{["arrived","working","done"].includes(r.status) ? "Прибыл за" : "С вызова"}</span><b className={cx('mono', r.elapsed > NORM && 't-red')}>{mmss(r.elapsed)}</b></div>
      </div>

      <ol className="stepper">
        {['Принял', 'В пути', 'На месте', 'Работа', 'Готово'].map((s, i) => (
          <li key={s} className={cx(i < stepIdx && 'done', i === stepIdx && 'now')}><span>{i < stepIdx ? <Check size={13} strokeWidth={3} /> : i + 1}</span><small>{s}</small></li>
        ))}
      </ol>

      {['assigned','enroute','arrived'].includes(r.status) && <p className="muted small">После прибытия к месту назначения работа начнётся автоматически. Для реальной поездки включите передачу GPS, для проверки — симуляцию у диспетчера.</p>}
      {next && <Button variant={next[0] === 'resolve' ? 'success' : 'primary'} size="lg" block loading={busy} icon={(() => { const I = next[2]; return <I size={20} />; })()} onClick={advance} className="task-cta">{next[1]}</Button>}

      <div className="task-actions">
        <button onClick={onMap}><Navigation size={20} /><span>Маршрут</span></button>
        <button disabled={!dispatcher || callPhase !== 'idle'} onClick={() => dispatcher && useCall.getState().start(dispatcher.id, dispatcher.name)}><Phone size={20} /><span>Диспетчер</span></button>
        <button onClick={() => { if (dispatcher) useChat.getState().openDirect(dispatcher.id); onChat(); }}><MessageSquare size={20} /><span>Написать</span></button>
        <button className="warn" onClick={() => quick('delay', 'Задерживаюсь')}><Clock size={20} /><span>Задержка</span></button>
        <button className="danger" onClick={() => quick('help', 'Нужна помощь')}><LifeBuoy size={20} /><span>Помощь</span></button>
      </div>

      {stepIdx >= 2 && (
        <section className="checklist">
          <h3><ListChecks size={16} />Чек-лист · {r.qual}<span>{checked.length}/{items.length}</span></h3>
          {items.map((it, i) => (
            <label key={it} className={cx(checked.includes(i) && 'on')}>
              <input type="checkbox" checked={checked.includes(i)} onChange={() => setChecked(v => v.includes(i) ? v.filter(x => x !== i) : [...v, i])} />
              <span className="box"><Check size={13} strokeWidth={3} /></span>{it}
            </label>
          ))}
        </section>
      )}

      {['assigned', 'enroute', 'arrived'].includes(r.status) && <Button variant="danger" block onClick={() => {setDeclineReason('');setDeclining(true);}}>Отказаться от заявки</Button>}
      <Modal open={declining} onClose={() => {if (!declineBusy) setDeclining(false);}} eyebrow={`Заявка #${r.id} · ${r.stand}`} title="Отказ от заявки"
        footer={<><Button disabled={declineBusy} onClick={() => setDeclining(false)}>Назад</Button><Button variant="danger" loading={declineBusy} disabled={declineReason.trim().length < 3} onClick={decline}>Подтвердить отказ</Button></>}>
        <p className="muted">Заявка вернётся диспетчеру для нового назначения. Причина сохранится в журнале и общем канале смены. Время ожидания не обнулится.</p>
        <label className="field"><span>Причина отказа</span><textarea rows={4} maxLength={1000} value={declineReason} onChange={e => setDeclineReason(e.target.value)} placeholder="Например: нет необходимого инструмента или допуска к этому виду работ" autoFocus /></label>
      </Modal>
      <ReportModal open={report} r={r} checked={checked.map(i => items[i])} onClose={() => setReport(false)} />
    </article>
  );
}

function ReportModal({ open, r, checked, onClose }: { open: boolean; r: Request; checked: string[]; onClose(): void }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const dispatcher = useDispatcher();
  async function finish() {
    setBusy(true);
    try {
      await act.engineerStep(r.id, 'resolve');
      const summary = [`Отчёт по заявке #${r.id} · ${r.stand}`, `Дефект: ${r.description}`, text.trim() && `Выполнено: ${text.trim()}`, checked.length ? `Чек-лист: ${checked.join('; ')}` : ''].filter(Boolean).join('\n');
      const chat = useChat.getState();
      if (dispatcher) { await chat.openDirect(dispatcher.id); await chat.sendText(summary); }
      toast.ok('Заявка закрыта, отчёт отправлен диспетчеру');
      try { localStorage.removeItem(`rp.check.${r.id}`); } catch { /* ignore */ }
      onClose();
      await useOps.getState().reload();
    } catch (e) { toast.bad(errorText(e)); }
    finally { setBusy(false); }
  }
  return (
    <Modal open={open} onClose={onClose} eyebrow={`Заявка #${r.id}`} title="Закрыть работу"
      footer={<><Button onClick={onClose}>Назад</Button><Button variant="success" icon={<Check size={17} />} loading={busy} onClick={finish}>Закрыть и отправить</Button></>}>
      <p className="muted">Короткий отчёт уйдёт диспетчеру в личный чат.</p>
      <textarea rows={4} value={text} onChange={e => setText(e.target.value)} placeholder="Что сделано: заменён блок, устранена течь, требуется повторная проверка…" />
      {checked.length > 0 && <div className="report-check"><FileText size={15} />Чек-лист: {checked.length} пунктов отмечено</div>}
    </Modal>
  );
}

function ProfileTab() {
  const me = useOps(s => s.me)!;
  const online = useOps(s => s.online);
  const state = useOps(s => s.state)!;
  const [settings, setSettings] = useState(false);
  const tech = useMemo(() => state.techs.find(t => t.id === me.tech_id), [state, me.tech_id]);
  if (settings) return <div className="eng-settings"><SettingsModal tab="profile" page onClose={() => setSettings(false)} /><button className="eng-back" onClick={() => setSettings(false)}>Готово</button></div>;
  return (
    <div className="eng-scroll">
      <div className="profile-card" style={{ '--pc': me.avatar_color } as React.CSSProperties}>
        <div className="pp-cover" style={{ backgroundImage: `linear-gradient(180deg,rgba(10,14,23,.05),rgba(10,14,23,.42)),url("${apiUrl(`/api/profile/media/${me.id}/banner`)}")` }} />
        <Avatar name={me.name} color={me.avatar_color} src={apiUrl(`/api/profile/media/${me.id}/avatar`)} size={88} online={online} ring />
        <b>{me.name}</b>
        <span>@{me.username}</span>
        {me.bio && <p>{me.bio}</p>}
        <div className="chips center">{me.types.map(t => <span key={t} className="chip static">{t}</span>)}</div>
      </div>
      <div className="list-card">
        <div><span>Квалификация</span><b style={{ color: qualColor(me.qual) }}>{me.qual}</b></div>
        <div><span>База</span><b>{me.base}</b></div>
        <div><span>Скорость движения</span><b>{(tech?.speed_kmh ?? 0).toFixed(1)} км/ч</b></div>
        <div><span>Email</span><b>{me.email}</b></div>
      </div>
      <button className="list-link" onClick={() => setSettings(true)}><UserRound size={18} /><span>Профиль, безопасность и звук</span><ChevronRight size={18} /></button>
      <button className="list-link" onClick={() => toast.info(`Норматив прибытия — 15 минут с момента создания заявки. Таймер на карточке задачи.`, 'Норматив')}><Timer size={18} /><span>Норматив 15 минут</span><ChevronRight size={18} /></button>
      <Button variant="danger" block size="lg" onClick={() => act.logout()}>Выйти из аккаунта</Button>
    </div>
  );
}
