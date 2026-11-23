import { useEffect, useState, type FormEvent } from 'react';
import { Eye, EyeOff, ArrowRight, CheckCircle2, ShieldCheck, Radio, Timer, Route, LogIn, UserPlus, Server, Wifi, Save } from 'lucide-react';
import { get, post, errorText, getServerUrl, probeServer, saveServerUrl } from '../../lib/api';
import type { Meta } from '../../lib/types';
import { Button, Field, Segmented } from '../../components/ui';
import { Logo } from '../../components/BootScreen';
import { cx } from '../../lib/format';
import { desktop } from '../../lib/desktop';

type Mode = 'login' | 'register' | 'done';

export function AuthPage() {
  const [mode, setMode] = useState<Mode>(location.pathname.startsWith('/register') ? 'register' : 'login');
  const [meta, setMeta] = useState<Meta | null>(null);
  const [lastEmail, setLastEmail] = useState('');
  useEffect(() => {
    const loadMeta = () => get<Meta>('/api/meta').then(setMeta).catch(error => { void desktop.log(`Auth metadata request failed: ${errorText(error)}`); setMeta(null); });
    window.addEventListener('rampulse-server-changed', loadMeta);
    // A client-only install without a saved VPS must remain on the server setup/login
    // screen. Calling relative /api endpoints here can restore a stale local session;
    // redirecting to '/' then mounts this page again forever.
    if (desktop.clientOnly && !getServerUrl()) {
      void desktop.log('Auth bootstrap skipped: no VPS URL configured');
      return () => window.removeEventListener('rampulse-server-changed', loadMeta);
    }
    loadMeta();
    void desktop.log('Auth page checking existing session');
    get('/api/auth/me').then(() => { void desktop.log('Auth session restored'); desktop.setClientAuthenticated(true); location.replace('/'); }).catch(error => { void desktop.log(`Auth session check failed: ${errorText(error)}`); desktop.setClientAuthenticated(false); });
    return () => window.removeEventListener('rampulse-server-changed', loadMeta);
  }, []);

  return (
    <div className="auth">
      <div className="auth-bg" aria-hidden><img src="/assets/airport-login.webp" alt="" /></div>
      <main className="auth-wrap">
        <section className="auth-hero">
          <div className="auth-brand"><Logo size={44} /><div><b>RampPulse</b><small>{meta?.airport.name || 'Диспетчеризация перрона'}</small></div></div>
          <h1>Инженер у борта<br /><span>за 15 минут.</span></h1>
          <p>Система подбирает специалиста с нужным допуском и минимальным временем прибытия, прокладывает маршрут по рулёжным дорожкам и держит связь со сменой.</p>
          <ul className="auth-points">
            <li><Timer size={18} /><div><b>Норматив 15:00</b><span>контроль каждой заявки</span></div></li>
            <li><Route size={18} /><div><b>Маршрут по РД</b><span>с учётом перекрытий</span></div></li>
            <li><Radio size={18} /><div><b>Чат и звонки</b><span>диспетчер ↔ инженер</span></div></li>
          </ul>
        </section>

        <section className="auth-card glass">
          <ServerConnection />
          {mode !== 'done' && (
            <Segmented value={mode} onChange={v => { setMode(v); history.replaceState(null, '', v === 'register' ? '/register' : '/login'); }}
              options={[{ value: 'login', label: <><LogIn size={15} />Вход</> }, { value: 'register', label: <><UserPlus size={15} />Регистрация</> }]} />
          )}
          {mode === 'login' && <LoginForm meta={meta} initialEmail={lastEmail} onRegister={() => setMode('register')} />}
          {mode === 'register' && <RegisterForm meta={meta} onDone={email => { setLastEmail(email); setMode('done'); }} />}
          {mode === 'done' && (
            <div className="auth-done">
              <span className="done-mark"><CheckCircle2 size={30} /></span>
              <h2>Заявка отправлена</h2>
              <p>Диспетчер проверит квалификацию и допуски. После подтверждения войдите с указанным email и паролем — вы сразу попадёте в рабочий терминал.</p>
              <Button variant="primary" size="lg" block onClick={() => setMode('login')} icon={<ArrowRight size={18} />}>Перейти ко входу</Button>
            </div>
          )}
          <footer className="auth-foot"><ShieldCheck size={14} /><span>Защищённая сессия · пароли хранятся в виде PBKDF2-хеша</span></footer>
        </section>
      </main>
    </div>
  );
}

function ServerConnection() {
  const initialUrl = getServerUrl() || (location.protocol === 'https:' ? location.origin : '');
  const [url, setUrl] = useState(initialUrl);
  const [status, setStatus] = useState<'unconfigured' | 'checking' | 'connected' | 'error' | 'invalid'> (url ? 'checking' : 'unconfigured');
  const [message, setMessage] = useState('');
  const [logCopied, setLogCopied] = useState(false);
  useEffect(() => {
    if (!url) return;
    let active = true;
    probeServer(url).then(() => { if (active) { setStatus('connected'); setMessage('VPS RampPulse доступен по HTTPS.'); void desktop.log('Saved VPS health check succeeded'); } })
      .catch(error => { if (active) { const message = errorText(error); setStatus('error'); setMessage(message); void desktop.log(`Saved VPS health check failed: ${message}`); } });
    return () => { active = false; };
  }, []);

  async function test() {
    setStatus('checking'); setMessage('Проверяем HTTPS API…');
    void desktop.log('VPS API probe started');
    try {
      await probeServer(url);
      const previousUrl = getServerUrl();
      const savedUrl = saveServerUrl(url);
      if (previousUrl !== savedUrl) {
        desktop.setClientAuthenticated(false);
        desktop.setClientAccessToken('');
      }
      setStatus('connected');
      setMessage('Адрес API проверен и сохранён. Теперь можно войти.');
      void desktop.log('VPS API probe succeeded and server URL saved');
    }
    catch (error) { const text = errorText(error); setStatus(text.startsWith('Введите корректный') || text.startsWith('Укажите HTTPS') ? 'invalid' : 'error'); setMessage(text); void desktop.log(`VPS API probe failed: ${text}`); }
  }

  function save() {
    try {
      const previousUrl = getServerUrl();
      const savedUrl = saveServerUrl(url);
      if (previousUrl !== savedUrl) {
        desktop.setClientAuthenticated(false);
        desktop.setClientAccessToken('');
      }
      setStatus('connected');
      setMessage('Адрес сохранён. Обновляем подключение…');
      window.location.reload();
    } catch (error) { const text = errorText(error); setStatus(text.startsWith('Введите корректный') || text.startsWith('Укажите HTTPS') ? 'invalid' : 'error'); setMessage(text); }
  }

  return (
    <section className="server-connect" aria-label="Подключение к VPS">
      <div className="server-connect-title"><Server size={16} /><b>Сервер RampPulse</b><span className={`server-state ${status}`}>{({ unconfigured: 'Не настроен', checking: 'Проверка…', connected: 'Подключено', error: 'Недоступен', invalid: 'Неверный адрес' })[status]}</span></div>
      <label className="field"><span className="field-label">API URL</span><input type="url" value={url} onChange={e => { setUrl(e.target.value); setStatus('unconfigured'); setMessage(''); }} placeholder="https://api.example.com" autoCapitalize="none" spellCheck={false} /></label>
      {message && <p className={status === 'error' ? 'server-connect-error' : 'server-connect-note'} role="status">{message}</p>}
      <div className="server-connect-actions">
        <Button size="sm" icon={<Wifi size={15} />} loading={status === 'checking'} onClick={test}>Проверить подключение</Button>
        <Button size="sm" variant="primary" icon={<Save size={15} />} onClick={save}>Сохранить адрес</Button>
        {desktop.available && <Button size="sm" onClick={async () => { try { await navigator.clipboard.writeText(await desktop.readDiagnostics()); setLogCopied(true); } catch { setLogCopied(false); } }}>Скопировать лог</Button>}
      </div>
      {logCopied && <small role="status">Лог скопирован. Вставьте его в чат, если подключение снова зависнет.</small>}
      <small>Вход по логину и паролю ниже выполняется на выбранном VPS. Пароль и адрес не вшиваются в сборку.</small>
    </section>
  );
}

function PasswordInput({ value, onChange, autoComplete, placeholder }: { value: string; onChange(v: string): void; autoComplete: string; placeholder?: string }) {
  const [show, setShow] = useState(false);
  return (
    <span className="input-wrap">
      <input type={show ? 'text' : 'password'} value={value} onChange={e => onChange(e.target.value)} autoComplete={autoComplete} placeholder={placeholder} required />
      <button type="button" className="input-action" onClick={() => setShow(v => !v)} aria-label={show ? 'Скрыть пароль' : 'Показать пароль'}>{show ? <EyeOff size={18} /> : <Eye size={18} />}</button>
    </span>
  );
}

function LoginForm({ meta, initialEmail, onRegister }: { meta: Meta | null; initialEmail: string; onRegister(): void }) {
  const [login, setLogin] = useState(initialEmail);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e?: FormEvent, creds?: { login: string; password: string }) {
    e?.preventDefault();
    setBusy(true); setError(null);
    void desktop.log('Dispatcher login request started');
    try {
      if (desktop.clientOnly) {
        const serverUrl = getServerUrl();
        if (!serverUrl) throw new Error('Сначала укажите HTTPS адрес VPS и нажмите «Проверить подключение».');
        await probeServer(serverUrl);
      }
      const result = await post<{ token?: string }>('/api/auth/login', {
        email: (creds?.login ?? login).trim(),
        password: creds?.password ?? password,
        native_client: desktop.clientOnly,
      });
      if (!result || typeof result !== 'object') {
        throw new Error('VPS вернул пустой ответ при входе. Обновите сервер RampPulse и повторите попытку.');
      }
      if (desktop.clientOnly && !result.token) {
        throw new Error('Сервер VPS нужно обновить для входа в Windows-приложение. Сообщите администратору сервера.');
      }
      if (result.token) desktop.setClientAccessToken(result.token);
      void desktop.log('Login accepted by VPS; opening workspace');
      desktop.setClientAuthenticated(true);
      location.replace('/');
    } catch (err) {
      const message = errorText(err);
      void desktop.log(`Login request failed: ${message}`);
      desktop.setClientAuthenticated(false);
      setError(message);
      setBusy(false);
    }
  }

  return (
    <form className="auth-form" onSubmit={submit}>
      <div className="auth-head"><h2>С возвращением</h2><p>Войдите, чтобы открыть смену.</p></div>
      <Field label="Email или логин"><input value={login} onChange={e => setLogin(e.target.value)} autoComplete="username" spellCheck={false} placeholder="name@oto.ru или orlov" required autoFocus /></Field>
      <Field label="Пароль"><PasswordInput value={password} onChange={setPassword} autoComplete="current-password" placeholder="Введите пароль" /></Field>
      {error && <p className="form-error" role="alert">{error}</p>}
      <Button type="submit" variant="primary" size="lg" block loading={busy} icon={<ArrowRight size={18} />}>Войти</Button>
      {meta?.demo?.enabled && (
        <div className="demo">
          <span className="eyebrow">Быстрый вход для демонстрации</span>
          <div className="demo-row">
            <button type="button" onClick={() => submit(undefined, { login: meta.demo!.dispatcher_email, password: meta.demo!.dispatcher_password })}><b>Диспетчер</b><small>{meta.demo.dispatcher_email}</small></button>
            <button type="button" onClick={() => submit(undefined, { login: meta.demo!.engineer_email, password: meta.demo!.engineer_password })}><b>Инженер</b><small>{meta.demo.engineer_email}</small></button>
          </div>
        </div>
      )}
      <p className="auth-switch">Новый инженер? <button type="button" onClick={onRegister}>Подать заявку на доступ</button></p>
    </form>
  );
}

function strength(p: string) {
  let s = 0;
  if (p.length >= 8) s++;
  if (p.length >= 12) s++;
  if (/[A-ZА-Я]/.test(p) && /[a-zа-я]/.test(p)) s++;
  if (/\d/.test(p)) s++;
  if (/[^\w\s]/.test(p)) s++;
  return Math.min(4, s);
}

function RegisterForm({ meta, onDone }: { meta: Meta | null; onDone(email: string): void }) {
  const [f, setF] = useState({ name: '', username: '', email: '', password: '', qual: '', base: '' });
  const [types, setTypes] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF(v => ({ ...v, [k]: e.target.value }));
  useEffect(() => {
    if (meta) setF(v => ({ ...v, qual: v.qual || meta.quals[0] || '', base: v.base || meta.bases[0]?.id || '' }));
  }, [meta]);
  const s = strength(f.password);
  const usernameOk = /^[a-z0-9_.-]{3,32}$/i.test(f.username);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!types.length) { setError('Отметьте хотя бы один тип ВС'); return; }
    setBusy(true); setError(null);
    try {
      await post('/api/auth/register', { ...f, username: f.username.toLowerCase(), types });
      onDone(f.email);
    } catch (err) { setError(errorText(err)); }
    finally { setBusy(false); }
  }

  return (
    <form className="auth-form" onSubmit={submit}>
      <div className="auth-head"><h2>Заявка инженера</h2><p>Диспетчер подтвердит квалификацию и откроет доступ к смене.</p></div>
      <div className="row-2">
        <Field label="Имя и фамилия"><input value={f.name} onChange={set('name')} autoComplete="name" placeholder="Иванов Пётр" required minLength={2} /></Field>
        <Field label="Логин" error={f.username && !usernameOk ? 'латиница, цифры, . _ -' : null}><input value={f.username} onChange={set('username')} autoComplete="username" spellCheck={false} placeholder="petr_ivanov" required /></Field>
      </div>
      <Field label="Email"><input type="email" value={f.email} onChange={set('email')} autoComplete="email" spellCheck={false} placeholder="name@oto.ru" required /></Field>
      <Field label="Пароль" hint={f.password ? <span className={cx('strength', `s${s}`)}><i /><i /><i /><i /><em>{['слабый', 'слабый', 'средний', 'хороший', 'надёжный'][s]}</em></span> : 'Минимум 8 символов'}>
        <PasswordInput value={f.password} onChange={v => setF(x => ({ ...x, password: v }))} autoComplete="new-password" placeholder="Придумайте пароль" />
      </Field>
      <div className="row-2">
        <Field label="Квалификация"><select value={f.qual} onChange={set('qual')}>{meta?.quals.map(q => <option key={q}>{q}</option>)}</select></Field>
        <Field label="База"><select value={f.base} onChange={set('base')}>{meta?.bases.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}</select></Field>
      </div>
      <div className="field"><span className="field-label">Допуски на типы ВС</span>
        <div className="chips">{meta?.types.map(t => (
          <button type="button" key={t} className={cx('chip', types.includes(t) && 'on')} onClick={() => setTypes(v => v.includes(t) ? v.filter(x => x !== t) : [...v, t])}>{t}</button>
        ))}</div>
      </div>
      {error && <p className="form-error" role="alert">{error}</p>}
      <Button type="submit" variant="primary" size="lg" block loading={busy} disabled={f.password.length < 8 || !usernameOk} icon={<ArrowRight size={18} />}>Отправить заявку</Button>
    </form>
  );
}
