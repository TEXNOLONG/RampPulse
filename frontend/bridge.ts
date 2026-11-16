type JsonValue = Record<string, unknown>;
type TauriInvoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
type Unlisten = () => void;

interface RealtimeEvent {
  protocol: number;
  event_id: string;
  sequence: number;
  occurred_at_ms: number;
  kind: string;
  actor?: JsonValue | null;
  entity?: JsonValue | null;
  payload: JsonValue;
}

interface RealtimeSubscription {
  close(): void;
}

interface OtoBridgeAPI {
  request<T = JsonValue>(path: string, init?: RequestInit): Promise<T>;
  get<T = JsonValue>(path: string): Promise<T>;
  post<T = JsonValue>(path: string, body?: unknown): Promise<T>;
  socket(path?: string): WebSocket;
  airport(): Promise<JsonValue>;
  operations: {
    listRequests(): Promise<{ requests: JsonValue[] }>;
    createRequest(input: JsonValue): Promise<JsonValue>;
    setRequestStatus(id: number, status: string): Promise<JsonValue>;
    setShift(onShift: boolean): Promise<JsonValue>;
    previewRoute(from: string, to: string, blockedEdges?: string[]): Promise<JsonValue>;
    subscribe(handler: (event: RealtimeEvent) => void, onState?: (connected: boolean) => void): RealtimeSubscription;
  };
  messaging: {
    available(): Promise<boolean>;
    contacts(): Promise<{ contacts: JsonValue[] }>;
    rooms(): Promise<{ rooms: JsonValue[] }>;
    createDirect(peerId: number): Promise<JsonValue>;
    messages(roomId: number, limit?: number): Promise<{ messages: JsonValue[] }>;
    send(roomId: number, kind: 'text' | 'sticker', content: string): Promise<JsonValue>;
    upload(roomId: number, kind: 'file' | 'voice', file: Blob, fileName: string, duration?: number): Promise<JsonValue>;
    markRead(roomId: number, messageId: number): Promise<void>;
    signalCall(recipientId: number, signal: JsonValue): Promise<JsonValue>;
  };
  errorMessage(error: unknown): string;
  revealSplash(id: string, startedAt?: number, minimumMs?: number): Promise<void>;
  openSession(): Promise<void>;
  consumeDesktopStartup(): Promise<boolean>;
  chat: {
    available: boolean;
    initialize(userId: number, userName: string): Promise<JsonValue[]>;
    history(roomKind: string, peerId?: number): Promise<JsonValue>;
    createDirect(userId: number, peerId: number, userName: string, peerName: string): Promise<JsonValue>;
    loadMessages(roomId: number, userId: number): Promise<JsonValue[]>;
    sendMessage(args: JsonValue): Promise<JsonValue>;
    receiveMessage(args: JsonValue): Promise<JsonValue>;
    markRead(roomId: number, userId: number): Promise<void>;
    markSentRead(relayKey: string, userId: number): Promise<void>;
    listen(handler: (message: JsonValue, roomKind: string, senderId: number) => void): Promise<Unlisten>;
    listenCalls(handler: (signal: JsonValue) => void): Promise<Unlisten>;
    relay(message: JsonValue, roomKind: string, recipientId?: number): Promise<void>;
    signal(signal: JsonValue, recipientId: number): Promise<void>;
    relayRead(relayKey: string, senderId: number): Promise<void>;
  };
}

interface Window {
  otoBridge: OtoBridgeAPI;
  __TAURI__?: { core?: { invoke?: TauriInvoke }; event?: { listen?: (name: string, handler: (event: { payload: unknown }) => void) => Promise<Unlisten> } };
}

const bridgeErrorMessage = (error: unknown): string => {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error.trim()) return error;
  if (error && typeof error === 'object') {
    const object = error as Record<string, unknown>;
    for (const key of ['detail', 'message', 'error']) {
      if (typeof object[key] === 'string' && (object[key] as string).trim()) return object[key] as string;
    }
  }
  try { return JSON.stringify(error) || 'Неизвестная ошибка'; } catch (_) { return 'Неизвестная ошибка'; }
};
const invokeDesktop = <T>(command: string, args: Record<string, unknown>): Promise<T> => {
  const invoke = window.__TAURI__?.core?.invoke?.bind(window.__TAURI__.core);
  if (!invoke) return Promise.reject(new Error('Чат доступен в установленном приложении RampPulse'));
  return invoke<T>(command, args);
};

async function bridgeRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    credentials: 'same-origin',
    cache: 'no-store',
    ...init,
    headers: { ...(typeof init.body === 'string' ? { 'Content-Type': 'application/json' } : {}), ...(init.headers || {}) },
  });
  const contentType = response.headers.get('content-type') || '';
  const data: unknown = contentType.includes('application/json') ? await response.json().catch(() => ({})) : await response.text();
  if (response.status === 401) {
    const next = location.pathname === '/engineer' ? '/engineer' : '/';
    location.replace(`/login?next=${encodeURIComponent(next)}`);
    throw new Error('Сессия завершена. Войдите снова.');
  }
  if (!response.ok) throw new Error(bridgeErrorMessage(data));
  return data as T;
}

async function loadAirport(): Promise<JsonValue> {
  const invoke = window.__TAURI__?.core?.invoke?.bind(window.__TAURI__.core);
  if (invoke) {
    try {
      const value = await invoke<JsonValue>('load_airport_data');
      if (value && typeof value === 'object' && Array.isArray(value.stands)) return value;
    } catch (error) {
      console.warn('Локальная карта недоступна, загружаю данные через сервис:', bridgeErrorMessage(error));
    }
  }
  return bridgeRequest<JsonValue>('/api/airport');
}

window.otoBridge = {
  request: bridgeRequest,
  get: path => bridgeRequest(path, { method: 'GET' }),
  post: (path, body) => bridgeRequest(path, { method: 'POST', ...(body === undefined ? {} : { body: JSON.stringify(body) }) }),
  socket(path = '/ws') {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return new WebSocket(`${protocol}//${location.host}${path}`);
  },
  airport: loadAirport,
  operations: {
    listRequests: () => bridgeRequest('/api/requests'),
    createRequest: input => bridgeRequest('/api/requests', { method: 'POST', body: JSON.stringify(input) }),
    setRequestStatus: (id, status) => bridgeRequest(`/api/requests/${id}/status`, { method: 'POST', body: JSON.stringify({ status }) }),
    setShift: onShift => bridgeRequest('/api/shift', { method: 'POST', body: JSON.stringify({ on_shift: onShift }) }),
    previewRoute: (from, to, blockedEdges = []) => bridgeRequest('/api/routes/preview', {
      method: 'POST', body: JSON.stringify({ from, to, blocked_edges: blockedEdges }),
    }),
    subscribe(handler, onState = () => {}) {
      let closed = false;
      let socket: WebSocket | null = null;
      let reconnectTimer = 0;
      let heartbeatTimer = 0;
      let retryMs = 500;
      let lastSequence = 0;
      const connect = () => {
        if (closed) return;
        socket = window.otoBridge.socket('/ws');
        socket.onopen = () => {
          retryMs = 500;
          onState(true);
          heartbeatTimer = window.setInterval(() => {
            if (socket?.readyState === WebSocket.OPEN) socket.send('heartbeat');
          }, 25_000);
        };
        socket.onmessage = event => {
          try {
            const packet = JSON.parse(String(event.data)) as RealtimeEvent;
            if (typeof packet?.kind !== 'string') return;
            if (packet.kind !== 'connection_ready' && packet.kind !== 'heartbeat_ack' && packet.sequence <= lastSequence) return;
            if (packet.sequence > 0) lastSequence = packet.sequence;
            handler(packet);
          } catch (error) {
            console.error('RampPulse: некорректное realtime-событие', error);
          }
        };
        socket.onclose = () => {
          window.clearInterval(heartbeatTimer);
          onState(false);
          if (!closed) {
            reconnectTimer = window.setTimeout(connect, retryMs);
            retryMs = Math.min(15_000, retryMs * 2);
          }
        };
        socket.onerror = () => socket?.close();
      };
      connect();
      return {
        close() {
          closed = true;
          window.clearTimeout(reconnectTimer);
          window.clearInterval(heartbeatTimer);
          socket?.close();
          onState(false);
        },
      };
    },
  },
  messaging: {
    async available() {
      const meta=await bridgeRequest<JsonValue>('/api/meta');
      return Boolean((meta.features as Record<string,unknown> | undefined)?.server_chat);
    },
    contacts: () => bridgeRequest('/api/chat/contacts'),
    rooms: () => bridgeRequest('/api/chat/rooms'),
    createDirect: peerId => bridgeRequest('/api/chat/rooms/direct', { method: 'POST', body: JSON.stringify({ peer_id: peerId }) }),
    messages: (roomId, limit = 50) => bridgeRequest(`/api/chat/rooms/${roomId}/messages?limit=${limit}`),
    send: (roomId, kind, content) => bridgeRequest(`/api/chat/rooms/${roomId}/messages`, { method: 'POST', body: JSON.stringify({ kind, content }) }),
    upload: (roomId, kind, file, fileName, duration) => bridgeRequest(`/api/chat/rooms/${roomId}/attachments`, {
      method: 'POST', body: file, headers: {
        'Content-Type': file.type || 'application/octet-stream',
        'X-Chat-Kind': kind,
        'X-Chat-File-Name': encodeURIComponent(fileName),
        ...(duration === undefined ? {} : { 'X-Chat-Duration': String(duration) }),
      },
    }),
    markRead: async (roomId, messageId) => {
      await bridgeRequest(`/api/chat/rooms/${roomId}/read`, { method: 'POST', body: JSON.stringify({ message_id: messageId }) });
    },
    signalCall: (recipientId, signal) => bridgeRequest('/api/calls/relay', { method: 'POST', body: JSON.stringify({ recipient_id: recipientId, signal }) }),
  },
  errorMessage: bridgeErrorMessage,
  openSession: () => invokeDesktop<void>('open_secondary_session', {}),
  consumeDesktopStartup: () => invokeDesktop<boolean>('consume_desktop_startup', {}),
  async revealSplash(id, startedAt = performance.now(), minimumMs = 1800) {
    await new Promise(resolve => setTimeout(resolve, Math.max(0, minimumMs - (performance.now() - startedAt))));
    const splash = document.getElementById(id);
    if (!splash) return;
    splash.setAttribute('aria-hidden', 'true');
    splash.classList.add('is-leaving');
    await new Promise(resolve => window.setTimeout(resolve, 320));
    splash.remove();
  },
  chat: {
    available: Boolean(window.__TAURI__?.core?.invoke),
    initialize: (userId, userName) => invokeDesktop<JsonValue[]>('chat_initialize', { userId, userName }),
    history: (roomKind, peerId) => {
      const query = new URLSearchParams({ room_kind: roomKind });
      if (peerId !== undefined) query.set('peer_id', String(peerId));
      return bridgeRequest<JsonValue>(`/api/chat/history?${query}`);
    },
    createDirect: (userId, peerId, userName, peerName) => invokeDesktop<JsonValue>('chat_create_dm', { userId, peerId, userName, peerName }),
    loadMessages: (roomId, userId) => invokeDesktop<JsonValue[]>('chat_load_messages', { roomId, userId }),
    sendMessage: args => invokeDesktop<JsonValue>('chat_send_message', args),
    receiveMessage: args => invokeDesktop<JsonValue>('chat_receive_message', args),
    markRead: (roomId, userId) => invokeDesktop<void>('chat_mark_read', { roomId, userId }),
    markSentRead: (relayKey, userId) => invokeDesktop<void>('chat_mark_sent_read', { relayKey, userId }),
    listen: async handler => {
      const listen = window.__TAURI__?.event?.listen;
      if (!listen) return () => {};
      return listen('chat-message', event => {
        if (!event.payload || typeof event.payload !== 'object') return;
        const message = event.payload as JsonValue;
        handler(message, message.room_kind === 'direct' ? 'direct' : 'shift', Number(message.sender_id));
      });
    },
    listenCalls: async handler => {
      const listen = window.__TAURI__?.event?.listen;
      if (!listen) return () => {};
      return listen('call-signal', event => { if (event.payload && typeof event.payload === 'object') handler(event.payload as JsonValue); });
    },
    relay: async (message, roomKind, recipientId) => {
      await bridgeRequest('/api/chat/relay', { method: 'POST', body: JSON.stringify({ message, room_kind: roomKind, recipient_id: recipientId }) });
    },
    relayRead: async (relayKey, senderId) => {
      await bridgeRequest('/api/chat/relay-read', { method: 'POST', body: JSON.stringify({ relay_key:relayKey, sender_id:senderId }) });
    },
    signal: async (signal, recipientId) => {
      if (window.__TAURI__?.core?.invoke) await invokeDesktop<void>('call_emit_signal', { signal });
      await bridgeRequest('/api/calls/relay', { method: 'POST', body: JSON.stringify({ signal, recipient_id: recipientId }) });
    },
  },
};
