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
    const response = await fetch(path, Object.assign(Object.assign({ credentials: 'same-origin', cache: 'no-store' }, init), { headers: Object.assign(Object.assign({}, (init.body ? { 'Content-Type': 'application/json' } : {})), (init.headers || {})) }));
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
        available: true,
        initialize: async (userId, userName) => {
            var _a, _b, _c;
            const invoke = (_c = (_b = (_a = window.__TAURI__) === null || _a === void 0 ? void 0 : _a.core) === null || _b === void 0 ? void 0 : _b.invoke) === null || _c === void 0 ? void 0 : _c.bind(window.__TAURI__.core);
            if (invoke) {
                try { return await invoke('chat_initialize', { userId, userName }); } catch (_) {}
            }
            try {
                const res = await bridgeRequest('/api/chat/contacts');
                const contacts = res.contacts || [];
                const rooms = [{ id: 1, kind: 'shift', name: 'Общий канал смены', peer_name: 'Общий канал смены', unread: 0 }];
                for (const c of contacts) {
                    rooms.push({
                        id: Number(c.id) + 1000,
                        kind: 'direct',
                        name: c.name,
                        peer_id: c.id,
                        peer_name: c.name,
                        on_shift: c.on_shift,
                        unread: 0
                    });
                }
                return rooms;
            } catch (_) {
                return [{ id: 1, kind: 'shift', name: 'Общий канал смены', peer_name: 'Общий канал смены', unread: 0 }];
            }
        },
        history: (roomKind, peerId) => {
            const query = new URLSearchParams({ room_kind: roomKind });
            if (peerId !== undefined)
                query.set('peer_id', String(peerId));
            return bridgeRequest(`/api/chat/history?${query}`);
        },
        createDirect: async (userId, peerId, userName, peerName) => {
            var _a, _b, _c;
            const invoke = (_c = (_b = (_a = window.__TAURI__) === null || _a === void 0 ? void 0 : _a.core) === null || _b === void 0 ? void 0 : _b.invoke) === null || _c === void 0 ? void 0 : _c.bind(window.__TAURI__.core);
            if (invoke) {
                try { return await invoke('chat_create_dm', { userId, peerId, userName, peerName }); } catch (_) {}
            }
            return { id: Number(peerId) + 1000, kind: 'direct', name: peerName, peer_id: peerId, peer_name: peerName };
        },
        loadMessages: async (roomId, userId) => {
            var _a, _b, _c;
            const invoke = (_c = (_b = (_a = window.__TAURI__) === null || _a === void 0 ? void 0 : _a.core) === null || _b === void 0 ? void 0 : _b.invoke) === null || _c === void 0 ? void 0 : _c.bind(window.__TAURI__.core);
            if (invoke) {
                try { return await invoke('chat_load_messages', { roomId, userId }); } catch (_) {}
            }
            const isShift = Number(roomId) === 1;
            const peerId = isShift ? undefined : Number(roomId) - 1000;
            const res = await bridgeRequest(`/api/chat/history?room_kind=${isShift ? 'shift' : 'direct'}${peerId !== undefined ? '&peer_id=' + peerId : ''}`);
            return res.messages || [];
        },
        sendMessage: async (args) => {
            var _a, _b, _c;
            const invoke = (_c = (_b = (_a = window.__TAURI__) === null || _a === void 0 ? void 0 : _a.core) === null || _b === void 0 ? void 0 : _b.invoke) === null || _c === void 0 ? void 0 : _c.bind(window.__TAURI__.core);
            if (invoke) {
                try { return await invoke('chat_send_message', args); } catch (_) {}
            }
            return {
                id: Date.now(),
                room_id: args.roomId,
                sender_id: args.userId,
                sender_name: args.senderName,
                body: args.body,
                sticker: args.sticker,
                media_url: args.media_url,
                media_type: args.media_type,
                media_name: args.media_name,
                duration: args.duration,
                relay_key: args.relayKey,
                created_at: new Date().toISOString()
            };
        },
        receiveMessage: async (args) => {
            var _a, _b, _c;
            const invoke = (_c = (_b = (_a = window.__TAURI__) === null || _a === void 0 ? void 0 : _a.core) === null || _b === void 0 ? void 0 : _b.invoke) === null || _c === void 0 ? void 0 : _c.bind(window.__TAURI__.core);
            if (invoke) {
                try { return await invoke('chat_receive_message', args); } catch (_) {}
            }
            return args;
        },
        markRead: async (roomId, userId) => {
            var _a, _b, _c;
            const invoke = (_c = (_b = (_a = window.__TAURI__) === null || _a === void 0 ? void 0 : _a.core) === null || _b === void 0 ? void 0 : _b.invoke) === null || _c === void 0 ? void 0 : _c.bind(window.__TAURI__.core);
            if (invoke) {
                try { await invoke('chat_mark_read', { roomId, userId }); } catch (_) {}
            }
        },
        markSentRead: async (relayKey, userId) => {
            var _a, _b, _c;
            const invoke = (_c = (_b = (_a = window.__TAURI__) === null || _a === void 0 ? void 0 : _a.core) === null || _b === void 0 ? void 0 : _b.invoke) === null || _c === void 0 ? void 0 : _c.bind(window.__TAURI__.core);
            if (invoke) {
                try { await invoke('chat_mark_sent_read', { relayKey, userId }); } catch (_) {}
            }
        },
        listen: async (handler) => {
            var _a, _b;
            const listen = (_b = (_a = window.__TAURI__) === null || _a === void 0 ? void 0 : _a.event) === null || _b === void 0 ? void 0 : _b.listen;
            if (listen) {
                return listen('chat-message', event => {
                    if (!event.payload || typeof event.payload !== 'object')
                        return;
                    const message = event.payload;
                    handler(message, message.room_kind === 'direct' ? 'direct' : 'shift', Number(message.sender_id));
                });
            }
            return () => {};
        },
        listenCalls: async (handler) => {
            var _a, _b;
            const listen = (_b = (_a = window.__TAURI__) === null || _a === void 0 ? void 0 : _a.event) === null || _b === void 0 ? void 0 : _b.listen;
            if (listen) {
                return listen('call-signal', event => {
                    if (event.payload && typeof event.payload === 'object')
                        handler(event.payload);
                });
            }
            return () => {};
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
