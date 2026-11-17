import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, Phone, Search, Paperclip, Smile, Mic, SendHorizontal, Check, CheckCheck, Clock3, RotateCw, Hash, FileText, Download, X, Radio } from 'lucide-react';
import { useChat } from '../../store/chat';
import { useCall } from '../../store/call';
import type { ChatContact, ChatMessage, ChatRoom } from '../../lib/types';
import { Avatar, IconButton } from '../../components/ui';
import { cx, dayLabel, timeHM } from '../../lib/format';
import { STICKERS, Sticker } from './stickers';
import { VoicePlayer, VoiceRecorder } from './Voice';

/** Full chat UI: list ↔ conversation (single column, Telegram-compact). */
export function ChatView({ onClose, closeIcon }: { onClose?: () => void; closeIcon?: React.ReactNode }) {
  const [view, setView] = useState<'list' | 'room'>('room');
  const activeRoomId = useChat(s => s.activeRoomId);
  if (view === 'list' || !activeRoomId) return <RoomList onPick={() => setView('room')} onClose={onClose} closeIcon={closeIcon} />;
  return <Conversation onBack={() => setView('list')} onClose={onClose} closeIcon={closeIcon} />;
}

function RoomList({ onPick, onClose, closeIcon }: { onPick(): void; onClose?: () => void; closeIcon?: React.ReactNode }) {
  const { rooms, contacts, online, openRoom, openDirect, me, typing } = useChat();
  const [q, setQ] = useState('');
  const query = q.trim().toLowerCase();
  const shift = rooms.filter(r => r.kind === 'shift');
  const directs = rooms.filter(r => r.kind === 'direct');
  const withRoom = new Set(directs.map(r => r.peer_id));
  const people = contacts.filter(c => !withRoom.has(c.id) && (!query || c.name.toLowerCase().includes(query) || c.username.toLowerCase().includes(query)));
  const contactOf = (id: number | null) => contacts.find(c => c.id === id);
  const filteredDirects = directs.filter(r => !query || r.peer_name.toLowerCase().includes(query) || contactOf(r.peer_id)?.username.toLowerCase().includes(query));

  return (
    <div className="chat">
      <header className="chat-top">
        <div><span className="eyebrow">Связь смены</span><h2>Сообщения</h2></div>
        {onClose && <IconButton label="Закрыть" onClick={onClose}>{closeIcon || <X size={18} />}</IconButton>}
      </header>
      <label className="search chat-search"><Search size={16} /><input value={q} onChange={e => setQ(e.target.value)} placeholder="Поиск по имени или @логину" /></label>
      <div className="room-list">
        {shift.map(r => <RoomRow key={r.id} room={r} typing={typing[r.id]?.name} onClick={() => { openRoom(r.id); onPick(); }} />)}
        {filteredDirects.length > 0 && <div className="list-label">Личные диалоги</div>}
        {filteredDirects.map(r => <RoomRow key={r.id} room={r} contact={contactOf(r.peer_id)} online={r.peer_id != null && online.has(r.peer_id)} typing={typing[r.id]?.name} onClick={() => { openRoom(r.id); onPick(); }} />)}
        {people.length > 0 && <div className="list-label">{me?.role === 'dispatcher' ? 'Инженеры' : 'Диспетчеры'}</div>}
        {people.map(c => <ContactRow key={c.id} c={c} online={online.has(c.id)} onClick={() => { openDirect(c.id); onPick(); }} />)}
      </div>
    </div>
  );
}

function RoomRow({ room, contact, online, typing, onClick }: { room: ChatRoom; contact?: ChatContact; online?: boolean; typing?: string; onClick(): void }) {
  const active = useChat(s => s.activeRoomId === room.id);
  const shift = room.kind === 'shift';
  return (
    <button className={cx('room', active && 'on')} onClick={onClick}>
      {shift ? <span className="avatar channel"><Hash size={18} /></span> : <Avatar name={room.peer_name} color={contact?.avatar_color} size={44} online={online} />}
      <span className="room-main">
        <b>{shift ? room.name : room.peer_name}</b>
        <span>{typing ? <em className="typing-text">печатает…</em> : shift ? 'Общий канал · вся смена' : contact ? `@${contact.username}${contact.qual ? ` · ${contact.qual}` : ''}` : 'Личный диалог'}</span>
      </span>
      {room.unread > 0 && <span className="unread">{room.unread}</span>}
    </button>
  );
}

function ContactRow({ c, online, onClick }: { c: ChatContact; online: boolean; onClick(): void }) {
  return (
    <button className="room" onClick={onClick}>
      <Avatar name={c.name} color={c.avatar_color} size={44} online={online} />
      <span className="room-main"><b>{c.name}</b><span>{online ? 'в сети' : c.on_shift ? 'на смене' : 'не на смене'}{c.bio ? ` · ${c.bio}` : ''}</span></span>
    </button>
  );
}

function Conversation({ onBack, onClose, closeIcon }: { onBack(): void; onClose?: () => void; closeIcon?: React.ReactNode }) {
  const { activeRoomId, rooms, contacts, online, messages, typing, me } = useChat();
  const room = rooms.find(r => r.id === activeRoomId);
  const list = (activeRoomId && messages[activeRoomId]) || [];
  const peer = room?.kind === 'direct' ? contacts.find(c => c.id === room.peer_id) : undefined;
  const peerOnline = peer ? online.has(peer.id) : false;
  const t = activeRoomId ? typing[activeRoomId] : undefined;
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const [preview, setPreview] = useState<string | null>(null);
  const callPhase = useCall(s => s.phase);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [list.length, activeRoomId]);
  useEffect(() => { stick.current = true; }, [activeRoomId]);

  const grouped = useMemo(() => {
    const out: ({ day: string } | { m: ChatMessage; first: boolean; last: boolean })[] = [];
    let day = '';
    list.forEach((m, i) => {
      const d = dayLabel(m.created_at);
      if (d !== day) { out.push({ day: d }); day = d; }
      const prev = list[i - 1], next = list[i + 1];
      const near = (a?: ChatMessage) => a && a.sender_id === m.sender_id && Math.abs(new Date(a.created_at).getTime() - new Date(m.created_at).getTime()) < 5 * 60000 && dayLabel(a.created_at) === d;
      out.push({ m, first: !near(prev), last: !near(next) });
    });
    return out;
  }, [list]);

  if (!room) return null;
  const shift = room.kind === 'shift';
  const status = t ? `${shift ? t.name + ' ' : ''}печатает…` : shift ? `${contacts.filter(c => online.has(c.id)).length + 1} в сети` : peerOnline ? 'в сети' : peer?.on_shift ? 'на смене' : 'не в сети';

  return (
    <div className="chat">
      <header className="conv-head">
        <IconButton label="Все диалоги" onClick={onBack}><ArrowLeft size={19} /></IconButton>
        {shift ? <span className="avatar channel sm"><Hash size={16} /></span> : <Avatar name={room.peer_name} color={peer?.avatar_color} size={38} online={peerOnline} />}
        <div className="conv-title"><b>{shift ? room.name : room.peer_name}</b><span className={cx(t && 'typing-text', !t && peerOnline && 't-green')}>{status}</span></div>
        {!shift && peer && <IconButton label="Позвонить" className="call" disabled={callPhase !== 'idle'} onClick={() => useCall.getState().start(peer.id, peer.name)}><Phone size={18} /></IconButton>}
        {shift && <span className="conv-badge"><Radio size={14} />канал</span>}
        {onClose && <IconButton label="Закрыть" onClick={onClose}>{closeIcon || <X size={18} />}</IconButton>}
      </header>
      <div className="messages" ref={scroller} onScroll={e => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; }}>
        {list.length === 0 && (
          <div className="chat-empty"><span className="empty-icon">{shift ? <Hash size={22} /> : <Avatar name={room.peer_name} color={peer?.avatar_color} size={56} />}</span><b>{shift ? 'Канал смены' : 'Начните диалог'}</b><p>{shift ? 'Сообщения видят все диспетчеры и инженеры на смене.' : 'Напишите сообщение, отправьте стикер или голосовое.'}</p>
            <div className="quick-stickers">{STICKERS.slice(0, 4).map(s => <button key={s.key} onClick={() => useChat.getState().sendSticker(s.key)}><Sticker id={s.key} size={44} /></button>)}</div>
          </div>
        )}
        {grouped.map((g, i) => 'day' in g
          ? <div key={`d${i}`} className="day-sep"><span>{g.day}</span></div>
          : <Bubble key={g.m.localKey || g.m.id} m={g.m} own={g.m.sender_id === me?.id} first={g.first} last={g.last} showName={shift} onImage={setPreview} />)}
        {t && <div className="typing-bubble"><i /><i /><i /></div>}
      </div>
      <Composer />
      {preview && <div className="lightbox" onClick={() => setPreview(null)}><img src={preview} alt="" /></div>}
    </div>
  );
}

function Bubble({ m, own, first, last, showName, onImage }: { m: ChatMessage; own: boolean; first: boolean; last: boolean; showName: boolean; onImage(src: string): void }) {
  const contact = useChat(s => s.contacts.find(c => c.id === m.sender_id));
  const meta = (
    <span className="meta">
      {timeHM(m.created_at)}
      {own && (m.failed ? null : m.pending ? <Clock3 size={13} /> : m.read ? <CheckCheck size={15} className="read" /> : <Check size={15} />)}
    </span>
  );
  const bare = m.kind === 'sticker';
  return (
    <div className={cx('msg-row', own ? 'own' : 'peer', first && 'first', last && 'last')}>
      {!own && showName && <span className="msg-avatar">{last && <Avatar name={m.sender_name} color={contact?.avatar_color} size={30} />}</span>}
      <div className={cx('bubble', bare && 'bare', m.kind === 'voice' && 'voice-bubble', m.failed && 'failed')}>
        {!own && showName && first && !bare && <b className="msg-name" style={{ color: contact?.avatar_color || 'var(--accent-2)' }}>{m.sender_name}</b>}
        {m.kind === 'text' && <p>{m.body}{meta}</p>}
        {m.kind === 'sticker' && <><Sticker id={m.sticker || m.content} size={92} />{meta}</>}
        {m.kind === 'voice' && m.media_url && <><VoicePlayer src={m.media_url} duration={m.duration} own={own} seed={String(m.id) + (m.media_url || '')} />{meta}</>}
        {m.kind === 'file' && m.media_type?.startsWith('image/') && m.media_url && <><img className="msg-img" src={m.media_url} alt={m.media_name || ''} onClick={() => onImage(m.media_url!)} />{meta}</>}
        {m.kind === 'file' && !m.media_type?.startsWith('image/') && (
          <><a className="file" href={m.media_url || '#'} download={m.media_name || 'файл'} target="_blank" rel="noreferrer"><span><FileText size={20} /></span><div><b>{m.media_name || 'Файл'}</b><small>{m.media_type}</small></div><Download size={16} /></a>{meta}</>
        )}
        {m.failed && <button className="retry" onClick={() => m.localKey && useChat.getState().retry(m.localKey)}><RotateCw size={13} />Не доставлено · повторить</button>}
      </div>
    </div>
  );
}

function Composer() {
  const [text, setText] = useState('');
  const [stickers, setStickers] = useState(false);
  const [recording, setRecording] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  const roomId = useChat(s => s.activeRoomId);
  useEffect(() => { setText(''); setStickers(false); }, [roomId]);
  useLayoutEffect(() => {
    const a = area.current; if (!a) return;
    a.style.height = 'auto'; a.style.height = `${Math.min(140, a.scrollHeight)}px`;
  }, [text]);

  const send = () => { const v = text.trim(); if (!v) return; useChat.getState().sendText(v); setText(''); area.current?.focus(); };

  if (recording) return <div className="composer"><VoiceRecorder onCancel={() => setRecording(false)} onSend={(b, s) => { setRecording(false); useChat.getState().sendVoice(b, s); }} /></div>;
  return (
    <>
      {stickers && <div className="sticker-grid">{STICKERS.map(s => <button key={s.key} onClick={() => { useChat.getState().sendSticker(s.key); setStickers(false); }}><Sticker id={s.key} size={46} /></button>)}</div>}
      <div className="composer">
        <input ref={file} type="file" hidden onChange={e => { const f = e.target.files?.[0]; if (f) useChat.getState().sendFile(f); e.target.value = ''; }} />
        <IconButton label="Прикрепить файл" onClick={() => file.current?.click()}><Paperclip size={19} /></IconButton>
        <div className="composer-input">
          <textarea ref={area} rows={1} value={text} placeholder="Сообщение" maxLength={2000}
            onChange={e => { setText(e.target.value); useChat.getState().notifyTyping(); }}
            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(); } }} />
          <IconButton label="Стикеры" className={cx(stickers && 'on')} onClick={() => setStickers(v => !v)}><Smile size={19} /></IconButton>
        </div>
        {text.trim()
          ? <button className="send-btn" onClick={send} aria-label="Отправить"><SendHorizontal size={19} /></button>
          : <button className="send-btn mic" onClick={() => setRecording(true)} aria-label="Записать голосовое"><Mic size={19} /></button>}
      </div>
    </>
  );
}
