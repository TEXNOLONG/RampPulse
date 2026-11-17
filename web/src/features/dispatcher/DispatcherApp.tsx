import { useEffect, useMemo, useRef, useState } from 'react';
import { ClipboardList, Plane, Users, ScrollText, MessageSquare, Settings, Pause, Play, Sparkles, ChevronDown, Wifi, WifiOff, LogOut, UserRound, AppWindow, X } from 'lucide-react';
import { useOps, act } from '../../store/ops';
import { useChat, useUnreadTotal } from '../../store/chat';
import { AirportMap } from '../map/AirportMap';
import { pathLength, type Comparison, type MapEngine } from '../map/engine';
import { Queue, type QueueTab } from './Queue';
import { RequestDetail, TechDetail, AircraftDetail } from './Details';
import { NewRequestModal } from './NewRequestModal';
import { ChatPanel } from '../chat/ChatPanel';
import { SettingsModal, type SettingsTab } from '../settings/SettingsModal';
import { Avatar, Switch, toast } from '../../components/ui';
import { Logo } from '../../components/BootScreen';
import { cx, simClock } from '../../lib/format';
import { errorText, post } from '../../lib/api';
import { kpis } from './shared';
import { desktop } from '../../lib/desktop';
import type { Point, Request } from '../../lib/types';

const SPEEDS = [1, 2, 5, 10, 20, 50];

export function DispatcherApp() {
  const state = useOps(s => s.state)!;
  const airport = useOps(s => s.airport)!;
  const me = useOps(s => s.me)!;
  const online = useOps(s => s.online);
  const chatOpen = useChat(s => s.open);
  const unread = useUnreadTotal();
  const [tab, setTab] = useState<QueueTab>('requests');
  const [sel, setSel] = useState<{ request: number | null; tech: number | null; aircraft: number | null }>({ request: null, tech: null, aircraft: null });
  const [newReq, setNewReq] = useState<{ open: boolean; stand?: string }>({ open: false });
  const [settings, setSettings] = useState<SettingsTab | null>(null);
  const [compare, setCompare] = useState(false);
  const [comparison, setComparison] = useState<Comparison | null>(null);
  const [moveTech, setMoveTech] = useState<number | null>(null);
  const [menu, setMenu] = useState<'scenarios' | 'profile' | null>(null);
  const engine = useRef<MapEngine | null>(null);

  const request = sel.request != null ? state.active.find(r => r.id === sel.request) ?? null : null;
  const tech = sel.tech != null ? state.techs.find(t => t.id === sel.tech) ?? null : null;
  const aircraft = sel.aircraft != null ? state.aircraft.find(a => a.id === sel.aircraft) ?? null : null;
  const panel = request ? 'request' : tech ? 'tech' : aircraft ? 'aircraft' : null;
  const k = useMemo(() => kpis(state), [state]);

  useEffect(() => { document.body.classList.toggle('panel-open', Boolean(panel || chatOpen)); }, [panel, chatOpen]);
  useEffect(() => { if (sel.request != null && !request) setSel(s => ({ ...s, request: null })); }, [request, sel.request]);

  // Human vs system: pick the slowest eligible alternative as the "by eye" choice.
  useEffect(() => {
    if (!compare || !request?.tech_id) { setComparison(null); return; }
    if (comparison?.requestId === request.id) return;
    const sys = state.techs.find(t => t.id === request.tech_id);
    const stand = airport.stands.find(s => s.id === request.stand);
    const goal = stand && airport.nodes.find(n => n.id === stand.node);
    if (!sys || !goal || !engine.current) return;
    const alts = state.techs.filter(t => t.id !== sys.id && t.on_shift && (request.qual === 'auto' || t.qual === request.qual));
    if (!alts.length) { toast.info('Для сравнения нужен второй инженер с тем же допуском'); return; }
    let cancelled = false;
    (async () => {
      const scored = (await Promise.all(alts.map(async t => {
        const from = engine.current!.nearestNode(t.x, t.y);
        if (!from) return null;
        try {
          const res: any = await act.routePreview(from.id, goal.id);
          const points: Point[] = [[t.x, t.y], ...(res.points || []).map((p: any) => [p.x, p.y] as Point)];
          return { t, points, eta: pathLength(points) / Math.max(0.5, t.speed) / 60 };
        } catch { return null; }
      }))).filter(Boolean) as { t: typeof alts[number]; points: Point[]; eta: number }[];
      if (cancelled || !scored.length) return;
      scored.sort((a, b) => b.eta - a.eta);
      const human = scored[0];
      const sysPoints: Point[] = sys.route?.length > 1 ? [[sys.x, sys.y], ...sys.route.slice(1)] : [[sys.x, sys.y], [goal.x, goal.y]];
      setComparison({ requestId: request.id, human: human.points, system: sysPoints, humanName: human.t.name, humanEta: human.eta, systemEta: pathLength(sysPoints) / Math.max(0.5, sys.speed) / 60 });
    })();
    return () => { cancelled = true; };
  }, [compare, request?.id, request?.tech_id]);

  const select = (patch: Partial<typeof sel>) => setSel({ request: null, tech: null, aircraft: null, ...patch });
  const saved = comparison && comparison.requestId === request?.id ? Math.max(0, comparison.humanEta - comparison.systemEta) : null;

  async function scenario(n: number) {
    setMenu(null);
    try {
      const inUse = new Set(state.active.map(r => r.stand));
      const free = airport.stands.filter(s => !inUse.has(s.id) && state.aircraft.some(a => a.stand === s.id && a.status === 'parked'));
      const pool = free.length ? free : airport.stands.filter(s => !inUse.has(s.id));
      const standAt = (i: number) => pool[i % pool.length]?.id || airport.stands[0].id;
      const create = (stand: string, description: string, qual = 'auto', priority = 'normal') => act.createRequest({ stand, description, qual, extra: 'Демо-сценарий', priority });
      let created: any;
      if (n === 2) {
        const target = airport.stands.find(s => s.id === standAt(0))!;
        const t = state.techs.find(x => x.on_shift && x.status === 'free');
        const from = t && engine.current?.nearestNode(t.x, t.y);
        if (from) {
          const preview: any = await act.routePreview(from.id, target.node);
          const path = new Set<string>(preview.nodes || []);
          const edge = airport.edges.find(e => e.kind !== 'apron' && path.has(e.a) && path.has(e.b) && !state.blocked.includes(e.id));
          if (edge) await act.blockEdge(edge.id, true);
        }
        created = await create(target.id, 'Объезд перекрытой рулёжной дорожки');
      } else if (n === 3) {
        for (let i = 0; i < 3; i++) { const r = await create(standAt(i), `Пиковая нагрузка · борт ${i + 1} из 3`); if (!i) created = r; }
      } else if (n === 4) {
        created = await create(standAt(0), 'Отказ навигационного комплекса · требуется редкий допуск', 'Авионика');
      } else {
        created = await create(standAt(0), n === 5 ? 'Сравнение выбора диспетчера и системы' : 'Штатный вызов инженера на перрон');
        if (n === 5) setCompare(true);
      }
      await useOps.getState().reload();
      const id = Number(created?.id ?? created?.request?.id);
      if (id) select({ request: id });
      toast.ok(['Штатный вызов создан', 'РД перекрыта, маршрут перестроен', 'Три одновременные заявки', 'Запрошен редкий допуск', 'Сравнение маршрутов включено'][n - 1], `Сценарий ${n}`);
    } catch (e) { toast.bad(errorText(e), 'Сценарий не запущен'); }
  }

  return (
    <div className={cx('dispatch', panel && 'has-panel')}>
      <nav className="rail">
        <Logo size={38} />
        <div className="rail-nav">
          <RailBtn on={tab === 'requests'} label="Заявки" onClick={() => setTab('requests')} badge={state.active.length}><ClipboardList size={20} /></RailBtn>
          <RailBtn on={tab === 'flights'} label="Рейсы" onClick={() => setTab('flights')}><Plane size={20} /></RailBtn>
          <RailBtn on={tab === 'team'} label="Команда" onClick={() => setTab('team')} badge={state.registrations?.length}><Users size={20} /></RailBtn>
          <RailBtn on={tab === 'log'} label="Журнал" onClick={() => setTab('log')}><ScrollText size={20} /></RailBtn>
          <span className="rail-sep" />
          <RailBtn on={chatOpen} label="Связь смены" onClick={() => useChat.getState().setOpen(!chatOpen)} badge={unread}><MessageSquare size={20} /></RailBtn>
        </div>
        <div className="rail-foot">
          <RailBtn label="Настройки" onClick={() => setSettings('appearance')}><Settings size={20} /></RailBtn>
          <button className="rail-me" onClick={() => setMenu(menu === 'profile' ? null : 'profile')} aria-label="Профиль"><Avatar name={me.name} color={me.avatar_color} size={34} online={online} /></button>
        </div>
        {menu === 'profile' && (
          <div className="popover profile-pop glass" onMouseLeave={() => setMenu(null)}>
            <div className="pop-me"><Avatar name={me.name} color={me.avatar_color} size={44} /><div><b>{me.name}</b><span>@{me.username} · диспетчер</span></div></div>
            <button onClick={() => { setMenu(null); setSettings('profile'); }}><UserRound size={16} />Профиль</button>
            <button onClick={() => { setMenu(null); setSettings('appearance'); }}><Settings size={16} />Настройки</button>
            <button onClick={() => { setMenu(null); desktop.openSecondWindow().catch(e => toast.bad(errorText(e))); }}><AppWindow size={16} />Окно второго аккаунта</button>
            <button className="danger" onClick={() => act.logout()}><LogOut size={16} />Выйти</button>
          </div>
        )}
      </nav>

      <Queue tab={tab} onTab={setTab} selected={sel}
        onSelectRequest={id => { const r = state.active.find(x => x.id === id); select({ request: id, tech: null }); if (r) void r; }}
        onSelectTech={id => select({ tech: id })} onSelectAircraft={id => select({ aircraft: id })}
        onNewRequest={stand => setNewReq({ open: true, stand })} />

      <main className="workspace">
        <AirportMap selection={{ request: sel.request, tech: sel.tech ?? request?.tech_id ?? null, aircraft: sel.aircraft, stand: request?.stand ?? aircraft?.stand ?? null }}
          comparison={compare ? comparison : null} interactiveEdges onReady={e => { engine.current = e; }}
          onStand={id => {
            if (moveTech != null) return;
            const r = state.active.find(x => x.stand === id);
            if (r) select({ request: r.id }); else setNewReq({ open: true, stand: id });
          }}
          onTech={id => select({ tech: id })}
          onAircraft={id => select({ aircraft: id })}
          onEdge={(id, name) => {
            const blocked = state.blocked.includes(id);
            act.blockEdge(id, !blocked).then(() => toast.ok(`РД ${name || id} ${blocked ? 'открыта' : 'перекрыта'}`, 'Рулёжная дорожка')).catch(e => toast.bad(errorText(e)));
          }}
          onEmpty={() => {
            if (moveTech != null) return;
            select({});
          }} />
        {moveTech != null && <MoveTechOverlay techId={moveTech} engine={engine.current} onDone={() => setMoveTech(null)} />}

        <header className="cmdbar glass">
          <div className="cmd-title">
            <span className="eyebrow"><i className={cx('live', online ? 'on' : 'off')} />{online ? 'В эфире' : 'Нет связи'} · {airport.name}</span>
            <h2>Смена · <span className="mono">{simClock(state.sim_time)}</span></h2>
          </div>
          <div className="cmd-stats">
            <Stat value={state.active.length} label="активных" tone={state.active.some(r => r.priority === 'emergency') ? 'red' : undefined} />
            <Stat value={`${state.stats.techs_free}/${state.stats.techs_total}`} label="инженеров свободно" />
            <Stat value={state.stats.aircraft_parked} label="бортов на стоянках" />
          </div>
          <span className="cmd-sep" />
          <div className="cmd-stats kpi">
            <Stat value={k.avg == null ? '—' : k.avg.toFixed(1)} unit="мин" label="среднее прибытие" />
            <Stat value={k.sla == null ? '—' : `${Math.round(k.sla)}%`} label="в нормативе 15 мин" tone="green" />
            <Stat value={saved == null ? "—" : `+${saved.toFixed(1)}`} unit="мин" label="сэкономлено системой" tone="accent" />
          </div>
          <span className="cmd-spacer" />
          <div className="cmd-controls">
            <div className="sim">
              <select value={state.sim_speed} onChange={e => act.sim({ speed: Number(e.target.value) }).catch(err => toast.bad(errorText(err)))} aria-label="Скорость симуляции">
                {SPEEDS.map(s => <option key={s} value={s}>×{s}</option>)}
              </select>
              <button className={cx('sim-btn', !state.sim_running && 'paused')} onClick={() => act.sim({ running: !state.sim_running }).catch(e => toast.bad(errorText(e)))}>
                {state.sim_running ? <Pause size={15} /> : <Play size={15} />}<span>{state.sim_running ? 'Пауза' : 'Пуск'}</span>
              </button>
            </div>
            <span className={cx('conn', online ? 'on' : 'off')} title={online ? 'Связь с сервером установлена' : 'Переподключение…'}>{online ? <Wifi size={16} /> : <WifiOff size={16} />}</span>
          </div>
        </header>

        <div className="demobar">
          <div className="scenarios">
            <button className={cx('glass chip-btn', menu === 'scenarios' && 'on')} onClick={() => setMenu(menu === 'scenarios' ? null : 'scenarios')}><Sparkles size={15} />Сценарии<ChevronDown size={15} /></button>
            {menu === 'scenarios' && (
              <div className="popover scen-pop glass">
                <span className="eyebrow">Контрольные сценарии ТЗ</span>
                {[['Штатный вызов', 'Ближайший инженер по графу РД'], ['Перекрытие РД', 'Объезд закрытой рулёжки'], ['Пиковая нагрузка', 'Три борта одновременно'], ['Дефицит квалификации', 'Редкий допуск, очередь'], ['Человек vs система', 'Сравнение с выбором «на глаз»']].map(([t, d], i) => (
                  <button key={t} onClick={() => scenario(i + 1)}><i>{String(i + 1).padStart(2, '0')}</i><span><b>{t}</b><small>{d}</small></span></button>
                ))}
                <button className="danger-row" onClick={() => { setMenu(null); act.reset().then(() => { select({}); toast.ok('Демо-данные сброшены'); }); }}><X size={15} /><span><b>Сбросить смену</b><small>Удалить заявки и журнал</small></span></button>
              </div>
            )}
          </div>
          <label className="compare glass"><span className="legend-pair"><i className="h" /><i className="s" /></span>Человек vs система<Switch checked={compare} onChange={setCompare} label="Человек против системы" /></label>
          {compare && comparison && request && comparison.requestId === request.id && (
            <div className="compare-note glass"><span>{comparison.humanName}: {comparison.humanEta.toFixed(1)} мин</span><b>Система: {comparison.systemEta.toFixed(1)} мин</b></div>
          )}
          {compare && !request && <div className="compare-note glass"><span>Выберите заявку</span><b>для сравнения</b></div>}
        </div>

        <div className="legend glass">
          <span><i style={{ background: 'var(--glider)' }} />Планер</span><span><i style={{ background: 'var(--engine)' }} />Двигатель</span><span><i style={{ background: 'var(--avionics)' }} />Авионика</span>
          <span className="sep" /><span><i className="l-route" />Маршрут</span><span><i className="l-iso" />Зона 15 мин</span><span><i className="l-block" />Перекрытие</span>
        </div>
      </main>

      {panel && !chatOpen && (
        <aside className="detail glass" key={`${panel}-${sel.request ?? sel.tech ?? sel.aircraft}`}>
          {request && <RequestDetail r={request as Request} onClose={() => select({})} onTech={id => select({ tech: id })} />}
          {!request && tech && <TechDetail t={tech} onClose={() => select({})} onMove={id => setMoveTech(id)} />}
          {!request && !tech && aircraft && <AircraftDetail a={aircraft} onClose={() => select({})} onRequest={stand => setNewReq({ open: true, stand })} />}
        </aside>
      )}
      {chatOpen && <ChatPanel onClose={() => useChat.getState().setOpen(false)} />}

      <NewRequestModal open={newReq.open} stand={newReq.stand} onClose={() => setNewReq({ open: false })} onCreated={id => id && select({ request: id })} />
      <SettingsModal tab={settings} onClose={() => setSettings(null)} />
    </div>
  );
}

function RailBtn({ on, label, onClick, badge, children }: { on?: boolean; label: string; onClick(): void; badge?: number; children: React.ReactNode }) {
  return <button className={cx('rail-btn', on && 'on')} onClick={onClick} aria-label={label} data-tip={label}>{children}{badge ? <em>{badge > 99 ? '99+' : badge}</em> : null}</button>;
}

function Stat({ value, label, unit, tone }: { value: React.ReactNode; label: string; unit?: string; tone?: string }) {
  return <div className={cx('stat', tone && `t-${tone}`)}><b>{value}{unit && <small>{unit}</small>}</b><span>{label}</span></div>;
}

function MoveTechOverlay({ techId, engine, onDone }: { techId: number; engine: MapEngine | null; onDone(): void }) {
  return (
    <div className="move-overlay" onClick={e => {
      if (!engine) return;
      const p = engine.pointToMap(e.clientX, e.clientY);
      post(`/api/techs/${techId}/position`, { x: p.x, y: p.y }).then((r: any) => toast.ok(`Новое положение: ${r.node || 'узел РД'}`)).catch(err => toast.bad(errorText(err))).finally(onDone);
    }}>
      <div className="move-hint glass">Нажмите на карту, чтобы переместить инженера · <button onClick={e => { e.stopPropagation(); onDone(); }}>Отмена</button></div>
    </div>
  );
}
