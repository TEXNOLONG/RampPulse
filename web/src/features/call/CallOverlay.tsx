import { useEffect, useState } from 'react';
import { Phone, PhoneOff, Mic, MicOff, Minimize2, Maximize2, SignalHigh, SignalLow } from 'lucide-react';
import { useCall } from '../../store/call';
import { useChat } from '../../store/chat';
import { Avatar } from '../../components/ui';
import { cx, mmss } from '../../lib/format';

export function CallOverlay() {
  const c = useCall();
  const contact = useChat(s => s.contacts.find(x => x.id === c.peerId));
  const [now, setNow] = useState(Date.now());
  const [mini, setMini] = useState(false);
  useEffect(() => {
    if (c.phase !== 'active') return;
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, [c.phase]);
  useEffect(() => { if (c.phase === 'incoming' || c.phase === 'idle') setMini(false); }, [c.phase]);
  if (c.phase === 'idle') return null;

  const label = {
    outgoing: 'Вызов…', incoming: 'Входящий вызов', connecting: 'Соединение…', active: mmss((now - c.startedAt) / 1000), ended: c.reason, idle: '',
  }[c.phase];

  if (mini && c.phase === 'active') {
    return (
      <div className="call-mini glass" onClick={() => setMini(false)}>
        <Avatar name={c.peerName} color={contact?.avatar_color} size={32} />
        <div><b>{c.peerName}</b><span className="mono">{label}</span></div>
        <Wave level={c.remoteLevel} small />
        <button className="cm-btn" onClick={e => { e.stopPropagation(); c.toggleMute(); }} aria-label="Микрофон">{c.muted ? <MicOff size={16} /> : <Mic size={16} />}</button>
        <button className="cm-btn end" onClick={e => { e.stopPropagation(); c.hangup(); }} aria-label="Завершить"><PhoneOff size={16} /></button>
      </div>
    );
  }

  const speaking = Math.max(c.remoteLevel, 0);
  return (
    <div className={cx('call-overlay', c.phase)}>
      <div className="call-card">
        {c.phase === 'active' && <button className="call-min" onClick={() => setMini(true)} aria-label="Свернуть"><Minimize2 size={18} /></button>}
        <div className="call-avatar" style={{ '--lvl': speaking } as React.CSSProperties}>
          {(c.phase === 'outgoing' || c.phase === 'incoming') && <><span className="ring r1" /><span className="ring r2" /><span className="ring r3" /></>}
          <span className="speak" />
          <Avatar name={c.peerName} color={contact?.avatar_color} size={112} />
        </div>
        <h2>{c.peerName}</h2>
        <p className={cx('call-status', c.phase === 'active' && 'mono')}>{label}</p>
        {c.phase === 'active' && (
          <div className="call-q">{c.quality === 'poor' ? <><SignalLow size={14} />слабая связь</> : <><SignalHigh size={14} />защищённый канал</>}</div>
        )}
        {(c.phase === 'active' || c.phase === 'connecting') && <div className="call-waves"><Wave level={c.localLevel} label="Вы" /><Wave level={c.remoteLevel} label="Собеседник" /></div>}
        <div className="call-actions">
          {c.phase === 'incoming' ? (
            <>
              <CallBtn tone="end" onClick={c.decline} label="Отклонить"><PhoneOff size={26} /></CallBtn>
              <CallBtn tone="accept" onClick={c.accept} label="Ответить"><Phone size={26} /></CallBtn>
            </>
          ) : c.phase === 'ended' ? null : (
            <>
              <CallBtn tone={c.muted ? 'on' : 'mute'} onClick={c.toggleMute} label={c.muted ? 'Включить' : 'Микрофон'}>{c.muted ? <MicOff size={24} /> : <Mic size={24} />}</CallBtn>
              <CallBtn tone="end" onClick={() => c.hangup()} label="Завершить"><PhoneOff size={26} /></CallBtn>
              {c.phase === 'active' && <CallBtn tone="mute" onClick={() => setMini(true)} label="Свернуть"><Maximize2 size={22} /></CallBtn>}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function CallBtn({ tone, onClick, label, children }: { tone: string; onClick(): void; label: string; children: React.ReactNode }) {
  return <button className={cx('call-btn', tone)} onClick={onClick}><span>{children}</span><small>{label}</small></button>;
}

function Wave({ level, label, small }: { level: number; label?: string; small?: boolean }) {
  const bars = small ? 5 : 9;
  return (
    <div className={cx('wave', small && 'small')}>
      <div className="wave-bars">{Array.from({ length: bars }, (_, i) => {
        const center = 1 - Math.abs(i - (bars - 1) / 2) / ((bars - 1) / 2);
        return <i key={i} style={{ transform: `scaleY(${0.12 + level * (0.4 + 0.6 * center)})` }} />;
      })}</div>
      {label && <small>{label}</small>}
    </div>
  );
}
