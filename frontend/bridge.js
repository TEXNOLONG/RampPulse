"use strict";
var _a, _b;
const bridgeErrorMessage = (error) => {
    if (error instanceof Error && error.message)
        return error.message;
    if (typeof error === 'string' && error.trim())
        return error;
    if (error && typeof error === 'object') {
        const object = error;
        for (const key of ['detail', 'message', 'error']) {
            if (typeof object[key] === 'string' && object[key].trim())
                return object[key];
        }
    }
    try {
        return JSON.stringify(error) || 'Неизвестная ошибка';
    }
    catch (_) {
        return 'Неизвестная ошибка';
    }
};
const invokeDesktop = (command, args) => {
    var _a, _b, _c;
    const invoke = (_c = (_b = (_a = window.__TAURI__) === null || _a === void 0 ? void 0 : _a.core) === null || _b === void 0 ? void 0 : _b.invoke) === null || _c === void 0 ? void 0 : _c.bind(window.__TAURI__.core);
    if (!invoke)
        return Promise.reject(new Error('Чат доступен в установленном приложении RampPulse'));
    return invoke(command, args);
};
async function bridgeRequest(path, init = {}) {
    const response = await fetch(path, Object.assign(Object.assign({ credentials: 'same-origin', cache: 'no-store' }, init), { headers: Object.assign(Object.assign({}, (typeof init.body === 'string' ? { 'Content-Type': 'application/json' } : {})), (init.headers || {})) }));
    const contentType = response.headers.get('content-type') || '';
    const data = contentType.includes('application/json') ? await response.json().catch(() => ({})) : await response.text();
    if (response.status === 401) {
        const next = location.pathname === '/engineer' ? '/engineer' : '/';
        location.replace(`/login?next=${encodeURIComponent(next)}`);
        throw new Error('Сессия завершена. Войдите снова.');
    }
    if (!response.ok)
        throw new Error(bridgeErrorMessage(data));
    return data;
}
async function loadAirport() {
    var _a, _b, _c;
    const invoke = (_c = (_b = (_a = window.__TAURI__) === null || _a === void 0 ? void 0 : _a.core) === null || _b === void 0 ? void 0 : _b.invoke) === null || _c === void 0 ? void 0 : _c.bind(window.__TAURI__.core);
    if (invoke) {
        try {
            const value = await invoke('load_airport_data');
            if (value && typeof value === 'object' && Array.isArray(value.stands))
                return value;
        }
        catch (error) {
            console.warn('Локальная карта недоступна, загружаю данные через сервис:', bridgeErrorMessage(error));
        }
    }
    return bridgeRequest('/api/airport');
}
window.otoBridge = {
    request: bridgeRequest,
    get: path => bridgeRequest(path, { method: 'GET' }),
    post: (path, body) => bridgeRequest(path, Object.assign({ method: 'POST' }, (body === undefined ? {} : { body: JSON.stringify(body) }))),
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
        subscribe(handler, onState = () => { }) {
            let closed = false;
            let socket = null;
            let reconnectTimer = 0;
            let heartbeatTimer = 0;
            let retryMs = 500;
            let lastSequence = 0;
            const connect = () => {
                if (closed)
                    return;
                socket = window.otoBridge.socket('/ws');
                socket.onopen = () => {
                    retryMs = 500;
                    onState(true);
                    heartbeatTimer = window.setInterval(() => {
                        if ((socket === null || socket === void 0 ? void 0 : socket.readyState) === WebSocket.OPEN)
                            socket.send('heartbeat');
                    }, 25000);
                };
                socket.onmessage = event => {
                    try {
                        const packet = JSON.parse(String(event.data));
                        if (typeof (packet === null || packet === void 0 ? void 0 : packet.kind) !== 'string')
                            return;
                        if (packet.kind !== 'connection_ready' && packet.kind !== 'heartbeat_ack' && packet.sequence <= lastSequence)
                            return;
                        if (packet.sequence > 0)
                            lastSequence = packet.sequence;
                        handler(packet);
                    }
                    catch (error) {
                        console.error('RampPulse: некорректное realtime-событие', error);
                    }
                };
                socket.onclose = () => {
                    window.clearInterval(heartbeatTimer);
                    onState(false);
                    if (!closed) {
                        reconnectTimer = window.setTimeout(connect, retryMs);
                        retryMs = Math.min(15000, retryMs * 2);
                    }
                };
                socket.onerror = () => socket === null || socket === void 0 ? void 0 : socket.close();
            };
            connect();
            return {
                close() {
                    closed = true;
                    window.clearTimeout(reconnectTimer);
                    window.clearInterval(heartbeatTimer);
                    socket === null || socket === void 0 ? void 0 : socket.close();
                    onState(false);
                },
            };
        },
    },
    messaging: {
        async available() {
            var _a;
            const meta = await bridgeRequest('/api/meta');
            return Boolean((_a = meta.features) === null || _a === void 0 ? void 0 : _a.server_chat);
        },
        contacts: () => bridgeRequest('/api/chat/contacts'),
        rooms: () => bridgeRequest('/api/chat/rooms'),
        createDirect: peerId => bridgeRequest('/api/chat/rooms/direct', { method: 'POST', body: JSON.stringify({ peer_id: peerId }) }),
        messages: (roomId, limit = 50) => bridgeRequest(`/api/chat/rooms/${roomId}/messages?limit=${limit}`),
        send: (roomId, kind, content) => bridgeRequest(`/api/chat/rooms/${roomId}/messages`, { method: 'POST', body: JSON.stringify({ kind, content }) }),
        upload: (roomId, kind, file, fileName, duration) => bridgeRequest(`/api/chat/rooms/${roomId}/attachments`, {
            method: 'POST', body: file, headers: Object.assign({ 'Content-Type': file.type || 'application/octet-stream', 'X-Chat-Kind': kind, 'X-Chat-File-Name': encodeURIComponent(fileName) }, (duration === undefined ? {} : { 'X-Chat-Duration': String(duration) })),
        }),
        markRead: async (roomId, messageId) => {
            await bridgeRequest(`/api/chat/rooms/${roomId}/read`, { method: 'POST', body: JSON.stringify({ message_id: messageId }) });
        },
        signalCall: (recipientId, signal) => bridgeRequest('/api/calls/relay', { method: 'POST', body: JSON.stringify({ recipient_id: recipientId, signal }) }),
    },
    errorMessage: bridgeErrorMessage,
    openSession: () => invokeDesktop('open_secondary_session', {}),
    consumeDesktopStartup: () => invokeDesktop('consume_desktop_startup', {}),
    async revealSplash(id, startedAt = performance.now(), minimumMs = 1800) {
        await new Promise(resolve => setTimeout(resolve, Math.max(0, minimumMs - (performance.now() - startedAt))));
        const splash = document.getElementById(id);
        if (!splash)
            return;
        splash.setAttribute('aria-hidden', 'true');
        splash.classList.add('is-leaving');
        await new Promise(resolve => window.setTimeout(resolve, 320));
        splash.remove();
    },
    chat: {
        available: Boolean((_b = (_a = window.__TAURI__) === null || _a === void 0 ? void 0 : _a.core) === null || _b === void 0 ? void 0 : _b.invoke),
        initialize: (userId, userName) => invokeDesktop('chat_initialize', { userId, userName }),
        history: (roomKind, peerId) => {
            const query = new URLSearchParams({ room_kind: roomKind });
            if (peerId !== undefined)
                query.set('peer_id', String(peerId));
            return bridgeRequest(`/api/chat/history?${query}`);
        },
        createDirect: (userId, peerId, userName, peerName) => invokeDesktop('chat_create_dm', { userId, peerId, userName, peerName }),
        loadMessages: (roomId, userId) => invokeDesktop('chat_load_messages', { roomId, userId }),
        sendMessage: args => invokeDesktop('chat_send_message', args),
        receiveMessage: args => invokeDesktop('chat_receive_message', args),
        markRead: (roomId, userId) => invokeDesktop('chat_mark_read', { roomId, userId }),
        markSentRead: (relayKey, userId) => invokeDesktop('chat_mark_sent_read', { relayKey, userId }),
        listen: async (handler) => {
            var _a, _b;
            const listen = (_b = (_a = window.__TAURI__) === null || _a === void 0 ? void 0 : _a.event) === null || _b === void 0 ? void 0 : _b.listen;
            if (!listen)
                return () => { };
            return listen('chat-message', event => {
                if (!event.payload || typeof event.payload !== 'object')
                    return;
                const message = event.payload;
                handler(message, message.room_kind === 'direct' ? 'direct' : 'shift', Number(message.sender_id));
            });
        },
        listenCalls: async (handler) => {
            var _a, _b;
            const listen = (_b = (_a = window.__TAURI__) === null || _a === void 0 ? void 0 : _a.event) === null || _b === void 0 ? void 0 : _b.listen;
            if (!listen)
                return () => { };
            return listen('call-signal', event => { if (event.payload && typeof event.payload === 'object')
                handler(event.payload); });
        },
        relay: async (message, roomKind, recipientId) => {
            await bridgeRequest('/api/chat/relay', { method: 'POST', body: JSON.stringify({ message, room_kind: roomKind, recipient_id: recipientId }) });
        },
        relayRead: async (relayKey, senderId) => {
            await bridgeRequest('/api/chat/relay-read', { method: 'POST', body: JSON.stringify({ relay_key: relayKey, sender_id: senderId }) });
        },
        signal: async (signal, recipientId) => {
            var _a, _b;
            if ((_b = (_a = window.__TAURI__) === null || _a === void 0 ? void 0 : _a.core) === null || _b === void 0 ? void 0 : _b.invoke)
                await invokeDesktop('call_emit_signal', { signal });
            await bridgeRequest('/api/calls/relay', { method: 'POST', body: JSON.stringify({ signal, recipient_id: recipientId }) });
        },
    },
};
