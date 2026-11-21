import { useEffect, useRef, useState } from 'react';
import { UserRound, ShieldCheck, Bell, Palette, Headphones, Info, X, Save, KeyRound, LogOut, MonitorSmartphone, Mic, Volume2, Activity, Check } from 'lucide-react';
import { useOps, act } from '../../store/ops';
import { usePrefs } from '../../store/prefs';
import { Avatar, Button, Field, IconButton, Switch, Segmented, toast } from '../../components/ui';
import { get, post, errorText } from '../../lib/api';
import { cx, timeHM } from '../../lib/format';
import type { User } from '../../lib/types';
import { desktop } from '../../lib/desktop';
import { Logo } from '../../components/BootScreen';

export type SettingsTab = 'profile' | 'security' | 'notifications' | 'appearance' | 'devices' | 'about';

const TABS: { id: SettingsTab; label: string; icon: React.ReactNode }[] = [
  { id: 'profile', label: 'Профиль', icon: <UserRound size={17} /> },
  { id: 'security', label: 'Безопасность', icon: <ShieldCheck size={17} /> },
  { id: 'notifications', label: 'Уведомления', icon: <Bell size={17} /> },
  { id: 'appearance', label: 'Вид и карта', icon: <Palette size={17} /> },
  { id: 'devices', label: 'Звук и микрофон', icon: <Headphones size={17} /> },
  { id: 'about', label: 'О системе', icon: <Info size={17} /> },
];

const COLORS = ['#6366F1', '#8B5CF6', '#EC4899', '#EF4444', '#F59E0B', '#10B981', '#06B6D4', '#3B82F6', '#64748B'];

/** Settings: modal with sidebar on desktop, full-screen page on phones (`page` mode). */
export function SettingsModal({ tab, onClose, page }: { tab: SettingsTab | null; onClose(): void; page?: boolean }) {
  const [current, setCurrent] = useState<SettingsTab>(tab || 'profile');
  const [mobileList, setMobileList] = useState(true);
  useEffect(() => { if (tab) { setCurrent(tab); setMobileList(false); } }, [tab]);
  useEffect(() => {
    if (!tab || page) return;
    const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [tab, page, onClose]);
  if (!tab && !page) return null;

  const body = (
    <div className={cx('settings', page && 'page', page && mobileList && 'show-list')}>
      <nav className="settings-nav">
        <MeCard />
        {TABS.map(t => <button key={t.id} className={cx(current === t.id && 'on')} onClick={() => { setCurrent(t.id); setMobileList(false); }}>{t.icon}<span>{t.label}</span></button>)}
        <button className="danger" onClick={() => act.logout()}><LogOut size={17} /><span>Выйти из аккаунта</span></button>
      </nav>
      <section className="settings-body">
        <header className="settings-head">
          {page && <button className="back" onClick={() => setMobileList(true)}>‹ Настройки</button>}
          <h2>{TABS.find(t => t.id === current)?.label}</h2>
          {!page && <IconButton label="Закрыть" onClick={onClose}><X size={18} /></IconButton>}
        </header>
        <div className="settings-scroll">
          {current === 'profile' && <ProfileTab />}
          {current === 'security' && <SecurityTab />}
          {current === 'notifications' && <NotificationsTab />}
          {current === 'appearance' && <AppearanceTab />}
          {current === 'devices' && <DevicesTab />}
          {current === 'about' && <AboutTab />}
        </div>
      </section>
    </div>
  );
  if (page) return body;
  return <div className="overlay" onMouseDown={e => e.target === e.currentTarget && onClose()}><div className="modal settings-modal">{body}</div></div>;
}

function MeCard() {
  const me = useOps(s => s.me)!;
  const online = useOps(s => s.online);
  return (
    <div className="me-card">
      <Avatar name={me.name} color={me.avatar_color} size={46} online={online} />
      <div><b>{me.name}</b><span>@{me.username || '—'} · {me.role === 'dispatcher' ? 'диспетчер' : 'инженер'}</span></div>
    </div>
  );
}

function ProfileTab() {
  const me = useOps(s => s.me)!;
  const setMe = useOps(s => s.setMe);
  const [f, setF] = useState({ name: me.name, username: me.username, bio: me.bio, avatar_color: me.avatar_color });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const dirty = f.name !== me.name || f.username !== me.username || f.bio !== me.bio || f.avatar_color !== me.avatar_color;
  async function save() {
    setBusy(true); setErr(null);
    try {
      const { user } = await post<{ user: User }>('/api/profile', f);
      setMe(user);
      toast.ok('Профиль сохранён');
    } catch (e) { setErr(errorText(e)); }
    finally { setBusy(false); }
  }
  return (
    <div className="stack">
      <div className="profile-preview" style={{ '--pc': f.avatar_color } as React.CSSProperties}>
        <div className="pp-cover" />
        <Avatar name={f.name} color={f.avatar_color} size={84} ring />
        <b>{f.name || 'Имя'}</b>
        <span>@{f.username || 'login'}</span>
        {f.bio && <p>{f.bio}</p>}
      </div>
      <div className="field"><span className="field-label">Цвет профиля</span>
        <div className="swatches">{COLORS.map(c => <button key={c} className={cx('swatch', f.avatar_color.toLowerCase() === c.toLowerCase() && 'on')} style={{ background: c }} onClick={() => setF(v => ({ ...v, avatar_color: c }))} aria-label={c}>{f.avatar_color.toLowerCase() === c.toLowerCase() && <Check size={14} strokeWidth={3} />}</button>)}</div>
      </div>
      <div className="row-2">
        <Field label="Имя и фамилия"><input value={f.name} onChange={e => setF(v => ({ ...v, name: e.target.value }))} maxLength={64} /></Field>
        <Field label="Логин" hint="Используется для входа и поиска в чате"><span className="input-prefix"><i>@</i><input value={f.username} onChange={e => setF(v => ({ ...v, username: e.target.value.replace(/^@/, '') }))} maxLength={32} spellCheck={false} /></span></Field>
      </div>
      <Field label="О себе" hint={`${f.bio.length}/160 · видно коллегам в чате`}><textarea rows={2} value={f.bio} maxLength={160} onChange={e => setF(v => ({ ...v, bio: e.target.value }))} placeholder="Например: старший диспетчер, смена №2" /></Field>
      <div className="info-list">
        <div><span>Email</span><b>{me.email}</b></div>
        <div><span>Роль</span><b>{me.role === 'dispatcher' ? 'Диспетчер смены' : `Инженер ТО · ${me.qual || '—'}`}</b></div>
        {me.role === 'engineer' && <div><span>Допуски</span><b>{me.types.join(', ') || '—'}</b></div>}
        <div><span>В системе с</span><b>{new Date(me.created_at).toLocaleDateString('ru-RU')}</b></div>
      </div>
      {err && <p className="form-error">{err}</p>}
      <div className="actions-end"><Button variant="primary" icon={<Save size={16} />} disabled={!dirty} loading={busy} onClick={save}>Сохранить изменения</Button></div>
    </div>
  );
}

function SecurityTab() {
  const [f, setF] = useState({ current: '', next: '', repeat: '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [sessions, setSessions] = useState<number | null>(null);
  useEffect(() => { get<{ sessions: number }>('/api/profile').then(r => setSessions(r.sessions)).catch(() => {}); }, []);
  async function change() {
    if (f.next !== f.repeat) { setErr('Пароли не совпадают'); return; }
    setBusy(true); setErr(null);
    try {
      await post('/api/profile/password', { current_password: f.current, new_password: f.next });
      setF({ current: '', next: '', repeat: '' });
      setSessions(1);
      toast.ok('Пароль изменён, остальные устройства отключены');
    } catch (e) { setErr(errorText(e)); }
    finally { setBusy(false); }
  }
  return (
    <div className="stack">
      <div className="card-block">
        <h4><KeyRound size={16} />Смена пароля</h4>
        <Field label="Текущий пароль"><input type="password" value={f.current} onChange={e => setF(v => ({ ...v, current: e.target.value }))} autoComplete="current-password" /></Field>
        <div className="row-2">
          <Field label="Новый пароль" hint="Минимум 8 символов"><input type="password" value={f.next} onChange={e => setF(v => ({ ...v, next: e.target.value }))} autoComplete="new-password" /></Field>
          <Field label="Повторите пароль"><input type="password" value={f.repeat} onChange={e => setF(v => ({ ...v, repeat: e.target.value }))} autoComplete="new-password" /></Field>
        </div>
        {err && <p className="form-error">{err}</p>}
        <div className="actions-end"><Button variant="primary" loading={busy} disabled={!f.current || f.next.length < 8} onClick={change}>Изменить пароль</Button></div>
      </div>
      <div className="card-block">
        <h4><MonitorSmartphone size={16} />Активные устройства</h4>
        <p className="muted">Сейчас вход выполнен на <b className="t-text">{sessions ?? '…'}</b> {sessions === 1 ? 'устройстве' : 'устройствах'}. Сессия живёт 7 дней и хранится в защищённой cookie (HttpOnly).</p>
        <div className="actions-end"><Button variant="danger" disabled={!sessions || sessions < 2} onClick={() => post<{ removed: number }>('/api/auth/logout-others').then(r => { setSessions(1); toast.ok(`Отключено устройств: ${r.removed}`); }).catch(e => toast.bad(errorText(e)))}>Выйти на остальных устройствах</Button></div>
      </div>
      <div className="card-block subtle"><ShieldCheck size={18} /><p>После 5 неверных попыток вход блокируется на минуту. Пароли хранятся как PBKDF2-SHA256 (210 000 итераций).</p></div>
    </div>
  );
}

function NotificationsTab() {
  const p = usePrefs();
  const [perm, setPerm] = useState(typeof Notification !== 'undefined' ? Notification.permission : 'denied');
  const android = !!window.RampPulseAndroid;
  const readNativePermission = () => window.RampPulseAndroid?.notificationsEnabled?.() ?? (typeof Notification !== 'undefined' && Notification.permission === 'granted');
  const [nativeAllowed, setNativeAllowed] = useState(readNativePermission);
  const [pushReady, setPushReady] = useState<boolean | null>(null);
  useEffect(() => {
    if (!android) return;
    let active = true;
    void get<{ enabled: boolean }>('/api/push/status')
      .then(result => { if (active) setPushReady(result.enabled); })
      .catch(() => { if (active) setPushReady(false); });
    return () => { active = false; };
  }, [android]);
  return (
    <div className="stack">
      {android ? <>
        <Row title="Уведомления телефона" text={nativeAllowed ? 'Разрешены в Android' : 'Разрешите показывать звонки и сообщения, когда RampPulse закрыт'}>
          <Button size="sm" variant={nativeAllowed ? 'subtle' : 'primary'} onClick={() => {
            window.RampPulseAndroid?.requestNotifications();
            window.setTimeout(() => setNativeAllowed(readNativePermission()), 700);
          }}>{nativeAllowed ? 'Проверить' : 'Разрешить'}</Button>
        </Row>
        <div className="card-block subtle">
          <b>{pushReady === null ? 'Проверяем доставку…' : pushReady ? 'Фоновая доставка включена' : 'Фоновая доставка не настроена'}</b>
          <p>{pushReady ? 'Звонки, сообщения и назначенные заявки будут приходить, когда RampPulse закрыт.' : 'Для доставки в фоне нужен Firebase Cloud Messaging: файл приложения Firebase и серверный ключ. Без них Android не сможет показать уведомления из закрытого приложения.'}</p>
        </div>
      </> : <>
        <Row title="Звук новых сообщений" text="Короткий сигнал, когда чат свёрнут"><Switch checked={p.sound} onChange={v => p.set({ sound: v })} /></Row>
        <Row title="Системные уведомления" text={perm === 'denied' ? 'Запрещены в системе — разрешите в настройках ОС' : 'Сообщения и входящие звонки, когда окно неактивно'}>
          <Switch checked={p.desktopNotifications && perm === 'granted'} onChange={async v => {
            if (v && typeof Notification !== 'undefined' && Notification.permission !== 'granted') { const r = await Notification.requestPermission(); setPerm(r); if (r !== 'granted') return; }
            p.set({ desktopNotifications: v });
          }} />
        </Row>
        <Row title="Проверить уведомление" text="Покажет пример сообщения"><Button size="sm" onClick={() => toast.info('Так выглядит новое сообщение в чате', 'Иванов И. И.')}>Показать</Button></Row>
      </>}
    </div>
  );
}

function AppearanceTab() {
  const p = usePrefs();
  const themes = [
    { value: 'indigo', label: 'Ночная', color: '#7778f7' },
    { value: 'aviation', label: 'Авиационная', color: '#42a8e8' },
    { value: 'amber', label: 'Янтарная', color: '#e7a43d' },
    { value: 'teal', label: 'Бирюзовая', color: '#36c2ae' },
  ] as const;
  return (
    <div className="stack">
      <div className="theme-setting">
        <div><b>Цветовая тема</b><span>Акцент и тон интерфейса на этом устройстве</span></div>
        <div className="theme-picker" role="group" aria-label="Цветовая тема">
          {themes.map(theme => <button key={theme.value} type="button" className={cx('theme-choice', p.theme === theme.value && 'selected')} aria-pressed={p.theme === theme.value} onClick={() => p.set({ theme: theme.value })}>
            <i style={{ background: theme.color }} /><span>{theme.label}</span>
          </button>)}
        </div>
      </div>
      <Row title="Подписи на карте" text="Номера стоянок, баз и терминалов"><Switch checked={p.mapLabels} onChange={v => p.set({ mapLabels: v })} /></Row>
      <Row title="Маршруты всех инженеров" text="Иначе показывается только выбранный маршрут"><Switch checked={p.mapRoutes} onChange={v => p.set({ mapRoutes: v })} /></Row>
      <Row title="Уменьшить анимацию" text="Без плавных перелётов камеры и пульсаций — легче для слабых ПК"><Switch checked={p.reduceMotion} onChange={v => p.set({ reduceMotion: v })} /></Row>
      <Row title="Плотность интерфейса" text="Компактный режим показывает больше заявок"><Segmented value={p.density} onChange={v => p.set({ density: v })} options={[{ value: 'comfortable', label: 'Обычная' }, { value: 'compact', label: 'Компактная' }]} /></Row>
    </div>
  );
}

function DevicesTab() {
  const p = usePrefs();
  const [mics, setMics] = useState<MediaDeviceInfo[]>([]);
  const [speakers, setSpeakers] = useState<MediaDeviceInfo[]>([]);
  const [level, setLevel] = useState(0);
  const [testing, setTesting] = useState(false);
  const stop = useRef<() => void>(() => {});
  async function refresh() {
    try {
      const list = await navigator.mediaDevices.enumerateDevices();
      setMics(list.filter(d => d.kind === 'audioinput'));
      setSpeakers(list.filter(d => d.kind === 'audiooutput'));
    } catch { /* unsupported */ }
  }
  useEffect(() => { refresh(); return () => stop.current(); }, []);
  async function test() {
    if (testing) { stop.current(); return; }
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error(window.isSecureContext ? 'Микрофон недоступен' : 'Для микрофона нужен HTTPS');
      const stream = await navigator.mediaDevices.getUserMedia({ audio: p.micDeviceId ? { deviceId: { ideal: p.micDeviceId }, noiseSuppression: p.noiseSuppression } : true });
      await refresh();
      const ctx = new AudioContext(); const an = ctx.createAnalyser(); an.fftSize = 256;
      ctx.createMediaStreamSource(stream).connect(an);
      const buf = new Uint8Array(128); let raf = 0;
      const loop = () => { an.getByteTimeDomainData(buf); let pk = 0; for (const v of buf) pk = Math.max(pk, Math.abs(v - 128)); setLevel(Math.min(1, pk / 50)); raf = requestAnimationFrame(loop); };
      loop(); setTesting(true);
      stop.current = () => { cancelAnimationFrame(raf); stream.getTracks().forEach(t => t.stop()); ctx.close().catch(() => {}); setTesting(false); setLevel(0); };
    } catch (e: any) { toast.bad(e?.name === 'NotAllowedError' ? 'Доступ к микрофону запрещён' : e?.name === 'NotFoundError' ? 'Микрофон не найден' : errorText(e), 'Микрофон'); }
  }
  function beep() {
    const ctx = new AudioContext(); const o = ctx.createOscillator(); const g = ctx.createGain();
    o.frequency.value = 660; g.gain.value = 0.15; o.connect(g).connect(ctx.destination); o.start(); o.stop(ctx.currentTime + 0.4);
  }
  return (
    <div className="stack">
      <Field label="Микрофон"><select value={p.micDeviceId} onChange={e => p.set({ micDeviceId: e.target.value })}><option value="">Системный по умолчанию</option>{mics.map((d, i) => <option key={d.deviceId || i} value={d.deviceId}>{d.label || `Микрофон ${i + 1}`}</option>)}</select></Field>
      <div className="mic-test">
        <Button icon={<Mic size={16} />} variant={testing ? 'danger' : 'ghost'} onClick={test}>{testing ? 'Остановить проверку' : 'Проверить микрофон'}</Button>
        <div className="meter"><i style={{ transform: `scaleX(${level})` }} /></div>
        <Activity size={16} className={cx(level > 0.15 ? 't-green' : 'muted')} />
      </div>
      {mics.length === 0 && <p className="callout amber">Система не видит ни одного микрофона. На Linux проверьте профиль звуковой карты (pavucontrol → Configuration) — профиль «Off» отключает входы.</p>}
      <Field label="Динамик"><select value={p.speakerDeviceId} onChange={e => p.set({ speakerDeviceId: e.target.value })} disabled={!speakers.length}><option value="">Системный по умолчанию</option>{speakers.map((d, i) => <option key={d.deviceId || i} value={d.deviceId}>{d.label || `Динамик ${i + 1}`}</option>)}</select></Field>
      <div className="actions-start"><Button icon={<Volume2 size={16} />} onClick={beep}>Проверить звук</Button></div>
      <Row title="Шумоподавление" text="Убирает гул перрона и двигателей в звонках и голосовых"><Switch checked={p.noiseSuppression} onChange={v => p.set({ noiseSuppression: v })} /></Row>
    </div>
  );
}

function AboutTab() {
  const [ping, setPing] = useState<number | null>(null);
  const [health, setHealth] = useState<any>(null);
  const airport = useOps(s => s.airport);
  async function measure() {
    const t = performance.now();
    try { setHealth(await get('/healthz')); setPing(Math.round(performance.now() - t)); } catch { setPing(-1); }
  }
  useEffect(() => { measure(); }, []);
  return (
    <div className="stack">
      <div className="about-hero"><Logo size={52} /><div><b>RampPulse</b><span>Диспетчеризация инженеров перрона · v0.5.6</span></div></div>
      <div className="info-list">
        <div><span>Сервер</span><b>{location.host}</b></div>
        <div><span>Аэропорт</span><b>{airport?.name}</b></div>
        <div><span>Протокол</span><b>{health ? `v${health.protocol} · ${health.service}` : '—'}</b></div>
        <div><span>Задержка</span><b className={cx(ping != null && ping >= 0 && (ping < 120 ? 't-green' : 't-amber'))}>{ping == null ? '…' : ping < 0 ? 'нет ответа' : `${ping} мс`}</b></div>
        <div><span>Платформа</span><b>{desktop.available ? (desktop.isAndroid ? 'Android' : 'Desktop') : 'Браузер'}</b></div>
        <div><span>Проверено</span><b>{timeHM(new Date().toISOString())}</b></div>
      </div>
      <div className="actions-start"><Button icon={<Activity size={16} />} onClick={measure}>Замерить задержку</Button></div>
    </div>
  );
}

function Row({ title, text, children }: { title: string; text?: string; children: React.ReactNode }) {
  return <div className="setting-row"><div><b>{title}</b>{text && <span>{text}</span>}</div>{children}</div>;
}
