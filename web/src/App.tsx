import { useEffect, useState } from 'react';
import { RefreshCw, X } from 'lucide-react';
import { useOps } from './store/ops';
import { useChat } from './store/chat';
import { useCall } from './store/call';
import { usePrefs } from './store/prefs';
import { AuthPage } from './features/auth/AuthPage';
import { DispatcherApp } from './features/dispatcher/DispatcherApp';
import { EngineerApp } from './features/engineer/EngineerApp';
import { CallOverlay } from './features/call/CallOverlay';
import { Toaster, Button } from './components/ui';
import { BootScreen } from './components/BootScreen';
import { desktop } from './lib/desktop';
import { getServerUrl } from './lib/api';

function introWasPlayed() {
  try { return sessionStorage.getItem('ramppulse.intro-played.v1') === '1'; }
  catch { return false; }
}

export function App() {
  const [loggingOut, setLoggingOut] = useState(false);
  const [introComplete, setIntroComplete] = useState(introWasPlayed);
  useEffect(() => {
    void desktop.log(`UI started clientOnly=${desktop.clientOnly} serverConfigured=${Boolean(getServerUrl())}`);
    const onError = (event: ErrorEvent) => void desktop.log(`UI error: ${event.message} at ${event.filename}:${event.lineno}:${event.colno}`);
    const onRejection = (event: PromiseRejectionEvent) => void desktop.log(`Unhandled promise rejection: ${String(event.reason)}`);
    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', onRejection);
    return () => { window.removeEventListener('error', onError); window.removeEventListener('unhandledrejection', onRejection); };
  }, []);
  useEffect(() => { const onLogout = () => setLoggingOut(true); window.addEventListener('ramppulse:logout', onLogout); return () => window.removeEventListener('ramppulse:logout', onLogout); }, []);
  const path = location.pathname;
  const configuredClient = desktop.clientOnly && (!getServerUrl() || !desktop.clientAuthenticated());
  const close = desktop.available && !desktop.isAndroid
    ? <button className="win-close" onClick={() => desktop.close()} aria-label="Закрыть приложение" title="Закрыть приложение"><X size={16} /></button>
    : null;
  const logoutScreen = loggingOut && <div className="logout-overlay"><BootScreen mode="logout" /></div>;
  const completeIntro = () => {
    try { sessionStorage.setItem('ramppulse.intro-played.v1', '1'); } catch { /* keep running if storage is unavailable */ }
    setIntroComplete(true);
  };
  if (!introComplete) return <div className="logout-overlay"><BootScreen onAnimationComplete={completeIntro} /></div>;
  if (configuredClient || path.startsWith('/login') || path.startsWith('/register')) return <><AuthPage /><Toaster />{close}{logoutScreen}</>;
  return <><Workspace />{close}{logoutScreen}</>;
}

function Workspace() {
  const { me, loading, error, boot } = useOps();
  const reduceMotion = usePrefs(s => s.reduceMotion);
  const [bootTimedOut, setBootTimedOut] = useState(false);
  const [diagnosticNotice, setDiagnosticNotice] = useState('');

  useEffect(() => {
    desktop.markReady();
    void desktop.log('Workspace boot started');
    void boot().then(() => {
      const result = useOps.getState();
      void desktop.log(`Workspace boot finished loading=${result.loading} error=${result.error || 'none'}`);
    });
  }, [boot]);
  useEffect(() => {
    if (!loading) { setBootTimedOut(false); return; }
    const timer = window.setTimeout(() => {
      setBootTimedOut(true);
      void desktop.log('Workspace boot exceeded 12 seconds');
    }, 12_000);
    return () => window.clearTimeout(timer);
  }, [loading]);
  useEffect(() => {
    if (!me) return;
    useChat.getState().init(me);
    useCall.getState().init();
  }, [me?.id]);
  useEffect(() => { document.documentElement.classList.toggle('reduce-motion', reduceMotion); }, [reduceMotion]);

  if (loading && !bootTimedOut) return <BootScreen />;
  if (loading && bootTimedOut) return <div className="fatal"><b>RampPulse не отвечает</b><p>Загрузка длится больше 12 секунд. Проверьте адрес и доступность VPS.</p><div className="fatal-actions"><Button variant="primary" onClick={() => location.reload()}>Повторить</Button><Button onClick={() => location.replace('/login')}>Подключение к VPS</Button><Button onClick={async () => { try { await navigator.clipboard.writeText(await desktop.readDiagnostics()); setDiagnosticNotice('Лог скопирован. Вставьте его в чат.'); } catch { setDiagnosticNotice('Не удалось скопировать лог.'); } }}>Скопировать лог</Button></div>{diagnosticNotice && <p role="status">{diagnosticNotice}</p>}</div>;
  if (error || !me) {
    return (
      <div className="fatal">
        <b>Не удалось открыть смену</b>
        <p>{error || 'Сессия не найдена'}</p>
        <Button variant="primary" icon={<RefreshCw size={16} />} onClick={() => location.reload()}>Повторить</Button>
        <Button onClick={async () => { try { await navigator.clipboard.writeText(await desktop.readDiagnostics()); setDiagnosticNotice('Лог скопирован. Вставьте его в чат.'); } catch { setDiagnosticNotice('Не удалось скопировать лог.'); } }}>Скопировать лог</Button>
        {diagnosticNotice && <p role="status">{diagnosticNotice}</p>}
      </div>
    );
  }
  return (
    <>
      {me.role === 'dispatcher' ? <DispatcherApp /> : <EngineerApp />}
      <CallOverlay />
      <Toaster />
    </>
  );
}
