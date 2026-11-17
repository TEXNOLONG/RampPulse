import { useEffect } from 'react';
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

export function App() {
  const path = location.pathname;
  const close = desktop.available && !desktop.isAndroid
    ? <button className="win-close" onClick={() => desktop.close()} aria-label="Закрыть приложение" title="Закрыть приложение"><X size={16} /></button>
    : null;
  if (path.startsWith('/login') || path.startsWith('/register')) return <><AuthPage /><Toaster />{close}</>;
  return <><Workspace />{close}</>;
}

function Workspace() {
  const { me, loading, error, boot } = useOps();
  const reduceMotion = usePrefs(s => s.reduceMotion);

  useEffect(() => { boot(); desktop.markReady(); }, [boot]);
  useEffect(() => {
    if (!me) return;
    useChat.getState().init(me);
    useCall.getState().init();
  }, [me?.id]);
  useEffect(() => { document.documentElement.classList.toggle('reduce-motion', reduceMotion); }, [reduceMotion]);

  if (loading) return <BootScreen />;
  if (error || !me) {
    return (
      <div className="fatal">
        <b>Не удалось открыть смену</b>
        <p>{error || 'Сессия не найдена'}</p>
        <Button variant="primary" icon={<RefreshCw size={16} />} onClick={() => location.reload()}>Повторить</Button>
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
