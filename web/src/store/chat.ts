import { create } from 'zustand';
import { get, post, upload, errorText } from '../lib/api';
import { realtime } from '../lib/realtime';
import type { ChatContact, ChatMessage, ChatRoom, RealtimePacket, User } from '../lib/types';
import { prefs } from './prefs';
import { toast } from '../components/ui';

interface Typing { name: string; until: number }

interface ChatStore {
  me: User | null;
  ready: boolean;
  rooms: ChatRoom[];
  contacts: ChatContact[];
  messages: Record<number, ChatMessage[]>;
  activeRoomId: number | null;
  typing: Record<number, Typing>;
  online: Set<number>;
  open: boolean;
  init(me: User): Promise<void>;
  setOpen(open: boolean): void;
  refreshRooms(): Promise<void>;
  openRoom(id: number): Promise<void>;
  openDirect(peerId: number): Promise<void>;
  sendText(text: string): Promise<void>;
  sendSticker(key: string): Promise<void>;
  sendVoice(blob: Blob, durationSec: number): Promise<void>;
  sendFile(file: File): Promise<void>;
  retry(localKey: string): Promise<void>;
  notifyTyping(): void;
  handle(packet: RealtimePacket): void;
}

let typingSentAt = 0;
const retryJobs = new Map<string, () => Promise<void>>();

export const useChat = create<ChatStore>((set, getState) => ({
  me: null,
  ready: false,
  rooms: [],
  contacts: [],
  messages: {},
  activeRoomId: null,
  typing: {},
  online: new Set(),
  open: false,

  async init(me) {
    if (getState().ready) return;
    set({ me });
    realtime.on(packet => getState().handle(packet));
    try {
      const [{ rooms }, { contacts }, { online }] = await Promise.all([
        get<{ rooms: ChatRoom[] }>('/api/chat/rooms'),
        get<{ contacts: ChatContact[] }>('/api/chat/contacts'),
        get<{ online: number[] }>('/api/presence'),
      ]);
      set({ rooms, contacts, online: new Set(online), ready: true });
      const shift = rooms.find(r => r.kind === 'shift') || rooms[0];
      if (shift) await getState().openRoom(shift.id);
    } catch (error) {
      toast.bad(errorText(error), 'Чат недоступен');
    }
    setInterval(() => {
      const now = Date.now();
      const typing = getState().typing;
      if (Object.values(typing).some(t => t.until < now)) {
        set({ typing: Object.fromEntries(Object.entries(typing).filter(([, t]) => t.until >= now)) });
      }
    }, 1000);
  },

  setOpen(open) {
    set({ open });
    const id = getState().activeRoomId;
    if (open && id) markRead(id);
  },

  async refreshRooms() {
    try {
      const [{ rooms }, { contacts }] = await Promise.all([
        get<{ rooms: ChatRoom[] }>('/api/chat/rooms'),
        get<{ contacts: ChatContact[] }>('/api/chat/contacts'),
      ]);
      const online = getState().online;
      set({ rooms, contacts: contacts.map(c => ({ ...c, online: online.has(c.id) || c.online })) });
    } catch { /* keep */ }
  },

  async openRoom(id) {
    set({ activeRoomId: id });
    try {
      const { messages } = await get<{ messages: ChatMessage[] }>(`/api/chat/rooms/${id}/messages`);
      set(s => ({ messages: { ...s.messages, [id]: mergePending(messages, s.messages[id]) } }));
      markRead(id);
    } catch (error) {
      toast.bad(errorText(error), 'Не удалось открыть диалог');
    }
  },

  async openDirect(peerId) {
    const existing = getState().rooms.find(r => r.kind === 'direct' && r.peer_id === peerId);
    if (existing) return getState().openRoom(existing.id);
    try {
      const data = await post<any>('/api/chat/rooms/direct', { peer_id: peerId });
      const room: ChatRoom = data.room ?? data;
      await getState().refreshRooms();
      await getState().openRoom(room.id);
    } catch (error) {
      toast.bad(errorText(error), 'Не удалось начать диалог');
    }
  },

  async sendText(text) {
    const body = text.trim();
    if (!body) return;
    await sendOptimistic({ kind: 'text', body, content: body }, roomId => post(`/api/chat/rooms/${roomId}/messages`, { kind: 'text', content: body }));
  },

  async sendSticker(key) {
    await sendOptimistic({ kind: 'sticker', sticker: key, content: key }, roomId => post(`/api/chat/rooms/${roomId}/messages`, { kind: 'sticker', content: key }));
  },

  async sendVoice(blob, durationSec) {
    const ext = blob.type.includes('ogg') ? 'ogg' : blob.type.includes('mp4') ? 'm4a' : 'webm';
    const url = URL.createObjectURL(blob);
    await sendOptimistic({ kind: 'voice', media_url: url, media_type: blob.type, duration: Math.round(durationSec), media_name: 'Голосовое сообщение' },
      roomId => upload(`/api/chat/rooms/${roomId}/attachments`, blob, {
        'x-chat-kind': 'voice', 'x-chat-duration': String(Math.max(1, Math.round(durationSec))), 'x-chat-file-name': encodeURIComponent(`voice.${ext}`),
      }));
  },

  async sendFile(file) {
    if (file.size > 100 * 1024 * 1024) { toast.bad('Файл больше 100 МБ'); return; }
    const url = file.type.startsWith('image/') ? URL.createObjectURL(file) : null;
    await sendOptimistic({ kind: 'file', media_url: url, media_type: file.type, media_name: file.name },
      roomId => upload(`/api/chat/rooms/${roomId}/attachments`, file, { 'x-chat-kind': 'file', 'x-chat-file-name': encodeURIComponent(file.name) }));
  },

  async retry(localKey) {
    const job = retryJobs.get(localKey);
    if (job) await job();
  },

  notifyTyping() {
    const id = getState().activeRoomId;
    if (!id || Date.now() - typingSentAt < 2500) return;
    typingSentAt = Date.now();
    post(`/api/chat/rooms/${id}/typing`).catch(() => {});
  },

  handle(packet) {
    const { kind, payload } = packet;
    const me = getState().me;
    if (kind === 'chat_message_created') {
      const message = payload as ChatMessage;
      set(s => {
        const list = s.messages[message.room_id];
        const typing = { ...s.typing }; delete typing[message.room_id];
        if (!list) return { typing };
        if (list.some(m => m.id === message.id)) return { typing };
        return { typing, messages: { ...s.messages, [message.room_id]: [...list, message] } };
      });
      const state = getState();
      const visible = state.open && state.activeRoomId === message.room_id && document.visibilityState === 'visible';
      if (visible) markRead(message.room_id);
      else {
        set(s => ({ rooms: s.rooms.map(r => r.id === message.room_id ? { ...r, unread: r.unread + 1 } : r) }));
        if (!state.rooms.some(r => r.id === message.room_id)) state.refreshRooms();
      }
      if (message.sender_id !== me?.id && !visible) notify(message);
      return;
    }
    if (kind === 'chat_message_read') {
      const { room_id, message_id, user_id } = payload;
      if (user_id === me?.id) return;
      set(s => {
        const list = s.messages[room_id];
        if (!list) return {};
        return { messages: { ...s.messages, [room_id]: list.map(m => m.sender_id === me?.id && m.id <= message_id ? { ...m, read: true } : m) } };
      });
      return;
    }
    if (kind === 'chat_typing') {
      const { room_id, name } = payload;
      set(s => ({ typing: { ...s.typing, [room_id]: { name, until: Date.now() + 4000 } } }));
      return;
    }
    if (kind === 'presence_changed') {
      const { user_id, online, profile } = payload;
      set(s => {
        const next = new Set(s.online);
        online ? next.add(user_id) : next.delete(user_id);
        return {
          online: next,
          contacts: s.contacts.map(c => c.id === user_id ? { ...c, online, ...(profile || {}) } : c),
          rooms: profile ? s.rooms.map(r => r.peer_id === user_id ? { ...r, peer_name: profile.name } : r) : s.rooms,
        };
      });
      return;
    }
    if (kind === 'connection_ready') {
      getState().refreshRooms();
      const id = getState().activeRoomId;
      if (id) getState().openRoom(id);
      get<{ online: number[] }>('/api/presence').then(({ online }) => set({ online: new Set(online) })).catch(() => {});
    }
  },
}));

function mergePending(server: ChatMessage[], local: ChatMessage[] | undefined) {
  const pending = (local || []).filter(m => m.pending || m.failed);
  return [...server, ...pending];
}

async function sendOptimistic(partial: Partial<ChatMessage>, request: (roomId: number) => Promise<any>) {
  const state = useChat.getState();
  const roomId = state.activeRoomId;
  const me = state.me;
  if (!roomId || !me) return;
  const localKey = `local-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const draft: ChatMessage = {
    id: Number.MAX_SAFE_INTEGER, room_id: roomId, room_kind: '', sender_id: me.id, sender_name: me.name,
    kind: 'text', body: '', content: '', sticker: null, media_url: null, media_name: null, media_type: null, duration: null,
    read: false, created_at: new Date().toISOString(), pending: true, localKey, ...partial,
  };
  const patch = (fn: (list: ChatMessage[]) => ChatMessage[]) =>
    useChat.setState(s => ({ messages: { ...s.messages, [roomId]: fn(s.messages[roomId] || []) } }));
  patch(list => [...list, draft]);
  const run = async () => {
    patch(list => list.map(m => m.localKey === localKey ? { ...m, pending: true, failed: false } : m));
    try {
      const { message } = await request(roomId);
      retryJobs.delete(localKey);
      patch(list => {
        const withoutDraft = list.filter(m => m.localKey !== localKey);
        return withoutDraft.some(m => m.id === message.id) ? withoutDraft : [...withoutDraft, message];
      });
    } catch (error) {
      patch(list => list.map(m => m.localKey === localKey ? { ...m, pending: false, failed: true } : m));
      toast.bad(errorText(error), 'Сообщение не отправлено');
    }
  };
  retryJobs.set(localKey, run);
  await run();
}

const readTimers = new Map<number, number>();
function markRead(roomId: number) {
  clearTimeout(readTimers.get(roomId));
  readTimers.set(roomId, window.setTimeout(() => {
    const list = useChat.getState().messages[roomId] || [];
    const last = [...list].reverse().find(m => !m.pending && !m.failed);
    useChat.setState(s => ({ rooms: s.rooms.map(r => r.id === roomId ? { ...r, unread: 0 } : r) }));
    if (last) post(`/api/chat/rooms/${roomId}/read`, { message_id: last.id }).catch(() => {});
  }, 250));
}

let audioCtx: AudioContext | null = null;
function notify(message: ChatMessage) {
  const p = prefs.get();
  if (p.sound) {
    try {
      audioCtx ??= new AudioContext();
      const t = audioCtx.currentTime;
      const o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.type = 'sine'; o.frequency.setValueAtTime(880, t); o.frequency.exponentialRampToValueAtTime(1320, t + 0.09);
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.12, t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.28);
      o.connect(g).connect(audioCtx.destination); o.start(t); o.stop(t + 0.3);
    } catch { /* audio blocked until user gesture */ }
  }
  const preview = message.kind === 'text' ? message.body : message.kind === 'voice' ? 'Голосовое сообщение' : message.kind === 'sticker' ? 'Стикер' : 'Вложение';
  if (p.desktopNotifications && 'Notification' in window && Notification.permission === 'granted' && document.visibilityState !== 'visible') {
    try { new Notification(message.sender_name, { body: preview, tag: `room-${message.room_id}` }); } catch { /* unsupported */ }
  } else if (!useChat.getState().open) {
    toast.info(preview, message.sender_name);
  }
}

export const useUnreadTotal = () => useChat(s => s.rooms.reduce((sum, r) => sum + (r.unread || 0), 0));
