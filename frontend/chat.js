(() => {
  const $ = (selector, root = document) => root.querySelector(selector);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const stickers = [
    ['accepted','Принято','<path d="m5 12 4 4L19 6"/>'],['enroute','Выезжаю','<path d="M4 12h14m-6-6 6 6-6 6"/>'],['delay','Задержка','<circle cx="12" cy="12" r="8"/><path d="M12 7v5l3 2"/>'],['ready','Борт готов','<path d="m3 13 7-2-3-6 2-.5 5 6 5-1a2 2 0 1 1 1 4l-5 1-1 7-2 .5-.5-7L4 17z"/>'],
    ['help','Нужна помощь','<circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.6 2.6 0 1 1 4.7 1.5c-1 1.2-2.2 1.4-2.2 3M12 17h.01"/>'],['tools','Инструменты','<path d="M14 6a5 5 0 0 0-6 6l-5 5 4 4 5-5a5 5 0 0 0 6-6l-3 3-4-4z"/>'],['engine','Двигатель','<path d="M4 10h3l2-3h5l2 3h3v7h-3l-2 2H9l-2-2H4zM19 12h2v3h-2"/>'],['power','Электрика','<path d="m13 2-9 12h7l-1 8 10-13h-7z"/>'],
    ['check','Проверка','<rect x="4" y="4" width="16" height="17" rx="2"/><path d="M8 9h8m-8 4h3m1 4 2 2 4-5"/>'],['radio','На связи','<path d="M5 20h14M7 17a7 7 0 0 1 10 0m-7-3a3 3 0 0 1 4 0M12 4v3"/><circle cx="12" cy="3" r="1"/>'],['fuel','Топливо','<path d="M5 21V4h10v17M4 21h12M8 8h4m5-1 3 3v7a2 2 0 0 0 4 0v-6l-3-3"/>'],['tow','Буксир','<path d="M3 16h13l2-5h3l2 5v3h-2M3 19h2m5 0h4M5 16V9h9v7M7 9V6h6v3"/>'],
    ['warning','Ограничение','<path d="M12 3 2.8 20h18.4zM12 9v5m0 3h.01"/>'],['medical','Медслужба','<rect x="4" y="5" width="16" height="15" rx="2"/><path d="M9 5V3h6v2m-3 4v7m-3.5-3.5h7"/>'],['done','Завершено','<circle cx="12" cy="12" r="9"/><path d="m7 12 3 3 7-7"/>'],['stand','Стоянка','<path d="M5 20V4h7a5 5 0 0 1 0 10H5m0-5h6"/>'],
  ];
  let identity = null, rooms = [], contacts = [], selectedRoom = null, messages = [], unreadTotal = 0;
  let unlistenChat = null, unlistenCalls = null, audioContext = null, ringInterval = 0, callClock = 0, call = null;
  let roomLoadToken = 0;
  const knownMessages = new Set();
  const pendingMessages = new Set();
  const failedMessages = new Set();
  function persistFailedMessages() {
    if (!identity) return;
    try { localStorage.setItem(`oto-chat-failed-${identity.id}`, JSON.stringify([...failedMessages])); } catch (_) {}
  }

  function invoke(command, args) { return window.otoBridge.chat[command](...args); }
  function timeLabel(value) {
    const stamp = String(value || '').replace(' ', 'T');
    const date = new Date(/[zZ]|[+-]\d{2}:?\d{2}$/.test(stamp) ? stamp : `${stamp}Z`);
    if (Number.isNaN(date.getTime())) return String(value || '');
    return new Intl.DateTimeFormat('ru-RU', {hour:'2-digit', minute:'2-digit'}).format(date);
  }
  function keyFor(message) { return message.relay_key || `${message.sender_id}:${message.id}:${message.created_at}`; }
  function updateUnread() {
    const badge = $('#chatUnread');
    badge.textContent = String(unreadTotal > 99 ? '99+' : unreadTotal);
    badge.hidden = unreadTotal < 1;
  }
  function stickerHtml(code, large = false) {
    const sticker = stickers.find(item => item[0] === code);
    if (!sticker) return '';
    return `<span class="chat-sticker-art ${large ? 'large' : ''}" aria-label="${esc(sticker[1])}"><svg viewBox="0 0 24 24" aria-hidden="true">${sticker[2]}</svg><b>${esc(sticker[1])}</b></span>`;
  }
  function renderStickerPicker() {
    $('#stickerPicker').innerHTML = stickers.map(([key,label,icon]) => `<button type="button" class="sticker-choice" data-sticker="${key}" aria-label="Отправить стикер: ${label}"><svg viewBox="0 0 24 24" aria-hidden="true">${icon}</svg><span>${label}</span></button>`).join('');
  }
  function renderRooms() {
    const existing = new Set(rooms.filter(room => room.kind === 'direct').map(room => Number(room.peer_id)));
    const roomButtons = rooms.map(room => `<button type="button" class="chat-room ${Number(selectedRoom?.id) === Number(room.id) ? 'active' : ''}" data-room-id="${room.id}" data-room-kind="${esc(room.kind)}"><span class="chat-room-mark">${room.kind === 'shift' ? 'S' : esc((room.peer_name || room.name || '·').trim().slice(0,1).toUpperCase())}</span><span class="chat-room-copy"><b>${esc(room.kind === 'shift' ? room.name : room.peer_name || room.name)}</b><small>${room.kind === 'shift' ? 'Общий канал' : 'Личный чат'}</small></span>${Number(room.unread) ? `<i class="chat-room-count">${room.unread}</i>` : ''}</button>`).join('');
    const contactButtons = contacts.filter(person => !existing.has(Number(person.id))).map(person => `<button type="button" class="chat-room" data-contact-id="${person.id}"><span class="chat-room-mark">${esc(person.name.trim().slice(0,1).toUpperCase())}</span><span class="chat-room-copy"><b>${esc(person.name)}</b><small>${person.on_shift ? 'На смене · личный чат' : 'Личный чат'}</small></span><i class="contact-led ${person.on_shift ? 'online' : ''}"></i></button>`).join('');
    $('#chatRooms').innerHTML = `<div class="chat-room-section-label">КАНАЛЫ И ДИАЛОГИ</div>${roomButtons}${contactButtons ? '<div class="chat-room-section-label contacts-label">СОТРУДНИКИ</div>' + contactButtons : ''}`;
  }
  function renderMessages() {
    const container = $('#chatMessages');
    if (!messages.length) {
      container.innerHTML = `<div class="chat-empty"><span class="chat-empty-mark"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11.5a7.5 7.5 0 0 1-7.5 7.5H5l1.7-3.5A7.5 7.5 0 1 1 20 11.5Z"/></svg></span><b>Начните разговор</b><p>Оперативные сообщения сохраняются на устройстве и приходят участникам канала сразу.</p></div>`;
      return;
    }
    container.innerHTML = messages.map(message => {
      const own = Number(message.sender_id) === Number(identity.id);
      const sticker = message.sticker ? stickerHtml(message.sticker, true) : '';
      let mediaHtml = '';
      if (message.media_url) {
        if (message.media_type === 'image') {
          mediaHtml = `<div class="chat-media-wrap"><a href="${esc(message.media_url)}" target="_blank"><img src="${esc(message.media_url)}" class="chat-media-img" alt="${esc(message.media_name||'Фото')}"/></a></div>`;
        } else if (message.media_type === 'audio_voice') {
          mediaHtml = `<div class="chat-voice-wrap"><audio controls src="${esc(message.media_url)}" class="chat-voice-audio"></audio><span class="chat-voice-label">🎙 ${esc(message.media_name || 'Голосовое сообщение')}</span></div>`;
        } else {
          mediaHtml = `<div class="chat-file-wrap"><a href="${esc(message.media_url)}" download="${esc(message.media_name||'файл')}" class="chat-file-link" target="_blank">📄 ${esc(message.media_name || 'Скачать файл')}</a></div>`;
        }
      }
      const key = keyFor(message);
      const status = pendingMessages.has(key) ? 'Отправка…' : failedMessages.has(key) ? 'Не доставлено' : message.read ? 'Прочитано' : 'Отправлено';
      const retry = own && failedMessages.has(key) ? `<button class="chat-retry" type="button" data-retry-message="${esc(key)}">Повторить</button>` : '';
      return `<article class="chat-message ${own ? 'own' : ''} ${failedMessages.has(key) ? 'delivery-failed' : ''}" data-message-key="${esc(key)}"><div class="chat-message-top"><b>${own ? 'Вы' : esc(message.sender_name || 'Участник')}</b><time>${esc(timeLabel(message.created_at))}</time></div>${message.body ? `<p>${esc(message.body)}</p>` : ''}${sticker}${mediaHtml}<div class="chat-message-meta">${own ? status : 'Смена'}${retry}</div></article>`;
    }).join('');
    container.scrollTop = container.scrollHeight;
  }
  async function refreshRooms() {
    rooms = await window.otoBridge.chat.initialize(Number(identity.id), identity.name);
    unreadTotal = rooms.reduce((total, room) => total + Number(room.unread || 0), 0);
    if (!selectedRoom) selectedRoom = rooms.find(room => room.kind === 'shift') || rooms[0] || null;
    else selectedRoom = rooms.find(room => Number(room.id) === Number(selectedRoom.id)) || selectedRoom;
    renderRooms();
    await loadSelectedRoom();
  }
  async function loadSelectedRoom() {
    if (!selectedRoom) return;
    const room = {...selectedRoom};
    const loadToken = ++roomLoadToken;
    unreadTotal = Math.max(0, unreadTotal - Number(room.unread || 0));
    $('#chatRoomName').textContent = room.kind === 'shift' ? room.name : room.peer_name || room.name;
    $('#chatRoomState').textContent = room.kind === 'shift' ? 'Сообщения команды · общий канал' : 'Личная связь · диспетчер ↔ инженер';
    $('#chatCall').disabled = room.kind !== 'direct' || !room.peer_id;
    try {
      const archive = await window.otoBridge.chat.history(room.kind, room.kind === 'direct' ? Number(room.peer_id) : undefined);
      if (loadToken !== roomLoadToken) return;
      for (const message of archive.messages || []) {
        if (!message.relay_key) continue;
        await window.otoBridge.chat.receiveMessage({roomId:Number(room.id),userId:Number(identity.id),senderId:Number(message.sender_id),senderName:String(message.sender_name || ''),body:String(message.body || ''),sticker:message.sticker || null,relayKey:String(message.relay_key),notify:false});
        if (Number(message.sender_id) === Number(identity.id) && message.read) {
          await window.otoBridge.chat.markSentRead(String(message.relay_key), Number(identity.id));
          failedMessages.delete(String(message.relay_key));
        }
      }
      persistFailedMessages();
    } catch (error) {
      console.warn('Не удалось обновить архив чата; показываю локальную историю', window.otoBridge.errorMessage(error));
    }
    if (loadToken !== roomLoadToken) return;
    messages = (await window.otoBridge.chat.loadMessages(Number(room.id), Number(identity.id))).reverse();
    const unread = messages.filter(message => Number(message.sender_id) !== Number(identity.id) && !message.read && message.relay_key);
    for (const message of unread) void window.otoBridge.chat.relayRead(String(message.relay_key), Number(message.sender_id)).catch(() => {});
    messages.forEach(message => knownMessages.add(keyFor(message)));
    await window.otoBridge.chat.markRead(Number(room.id), Number(identity.id));
    room.unread = 0;
    selectedRoom.unread = 0;
    renderRooms(); renderMessages(); updateUnread();
  }
  async function selectContact(id) {
    const person = contacts.find(item => Number(item.id) === Number(id));
    if (!person) return;
    selectedRoom = await window.otoBridge.chat.createDirect(Number(identity.id), Number(person.id), identity.name, person.name);
    await refreshRooms();
    $('#chatPanel').classList.add('open');
  }
  async function acceptMessage(message, kind = 'shift', senderId = Number(message.sender_id)) {
    const key = keyFor(message);
    if (knownMessages.has(key)) return;
    knownMessages.add(key);
    let roomId = Number(message.room_id);
    if (kind === 'direct' && Number(message.room_id) !== 1) {
      let localRoom = rooms.find(room => room.kind === 'direct' && Number(room.peer_id) === Number(senderId));
      if (!localRoom) {
        const peer = contacts.find(person => Number(person.id) === Number(senderId));
        if (!peer) return;
        const created = await window.otoBridge.chat.createDirect(Number(identity.id), Number(senderId), identity.name, peer.name);
        await refreshRooms();
        localRoom = rooms.find(room => Number(room.peer_id) === Number(senderId)) || created;
      }
      roomId = Number(localRoom.id);
      message = {...message, room_id: roomId};
      await window.otoBridge.chat.receiveMessage({roomId, userId:Number(identity.id), senderId:Number(senderId), senderName:String(message.sender_name || ''), body:String(message.body || ''), sticker:message.sticker || null, relayKey:key});
    } else if (kind === 'shift' && Number(senderId) !== Number(identity.id)) {
      roomId = 1;
      message = {...message, room_id:roomId};
      await window.otoBridge.chat.receiveMessage({roomId,userId:Number(identity.id),senderId:Number(senderId),senderName:String(message.sender_name || ''),body:String(message.body || ''),sticker:message.sticker || null,relayKey:key});
    }
    const open = !$('#chatPanel').hidden && selectedRoom && Number(selectedRoom.id) === roomId;
    if (open) {
      if (!messages.some(item => keyFor(item) === key)) messages.push(message);
      renderMessages();
      await window.otoBridge.chat.markRead(roomId, Number(identity.id));
    } else {
      unreadTotal += 1; updateUnread();
      const target = rooms.find(room => Number(room.id) === roomId);
      if (target) target.unread = Number(target.unread || 0) + 1;
      renderRooms();
    }
    if (kind === 'shift' && !open) toastIncoming(message.sender_name || 'Команда', 'Новое сообщение в канале смены');
  }
  function toastIncoming(title, text) {
    const node = $('#chatNotice');
    if (!node) return;
    node.innerHTML = `<b>${esc(title)}</b><span>${esc(text)}</span>`;
    node.hidden = false;
    clearTimeout(toastIncoming.timer);
    toastIncoming.timer = setTimeout(() => { node.hidden = true; }, 3600);
  }
  async function send(body = '', sticker = null, media = null) {
    if (!selectedRoom || (!body.trim() && !sticker && !media)) return;
    const targetRoom = {...selectedRoom};
    const relayKey = crypto.randomUUID ? crypto.randomUUID() : `${identity.id}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const args = {
      roomId: Number(targetRoom.id),
      userId: Number(identity.id),
      senderName: identity.name,
      body: body.trim(),
      sticker,
      relayKey,
      media_url: media?.url || null,
      media_type: media?.type || null,
      media_name: media?.name || null,
      duration: media?.duration || null
    };
    pendingMessages.add(relayKey);
    let message;
    try {
      message = await window.otoBridge.chat.sendMessage(args);
      if (selectedRoom && Number(selectedRoom.id) === Number(message.room_id) && !messages.some(item => keyFor(item) === relayKey)) {
        messages.push(message);
        knownMessages.add(relayKey);
        renderMessages();
      }
      await window.otoBridge.chat.relay(message, targetRoom.kind, targetRoom.peer_id ? Number(targetRoom.peer_id) : undefined);
      failedMessages.delete(relayKey);
      persistFailedMessages();
    } catch (error) {
      if (message) failedMessages.add(relayKey);
      persistFailedMessages();
      throw error;
    } finally {
      pendingMessages.delete(relayKey);
      renderMessages();
    }
    if (!sticker && $('#chatInput').value === body) {
      $('#chatInput').value = '';
      $('#chatInput').style.height = '';
    }
    $('#stickerPicker').hidden = true;
  }

  async function retryMessage(key) {
    const message = messages.find(item => keyFor(item) === key);
    if (!message || !failedMessages.has(key)) return;
    pendingMessages.add(key);
    failedMessages.delete(key);
    renderMessages();
    try {
      const room = rooms.find(item => Number(item.id) === Number(message.room_id));
      if (!room) throw new Error('Чат не найден. Выберите его снова и повторите отправку.');
      await window.otoBridge.chat.relay(message, room.kind, room.peer_id ? Number(room.peer_id) : undefined);
      persistFailedMessages();
    } catch (error) {
      failedMessages.add(key);
      persistFailedMessages();
      throw error;
    } finally {
      pendingMessages.delete(key);
      renderMessages();
    }
  }

  function ensureAudioContext() {
    if (!audioContext) audioContext = new (window.AudioContext || window.webkitAudioContext)();
    if (audioContext.state === 'suspended') void audioContext.resume();
  }
  function ringStart() {
    ensureAudioContext();
    ringStop();
    const play = () => {
      if (!audioContext || !call) return;
      const oscillator = audioContext.createOscillator();
      const gain = audioContext.createGain();
      oscillator.type = 'sine'; oscillator.frequency.value = 620;
      gain.gain.setValueAtTime(.0001, audioContext.currentTime);
      gain.gain.exponentialRampToValueAtTime(.045, audioContext.currentTime + .03);
      gain.gain.exponentialRampToValueAtTime(.0001, audioContext.currentTime + .28);
      oscillator.connect(gain); gain.connect(audioContext.destination);
      oscillator.start(); oscillator.stop(audioContext.currentTime + .3);
    };
    play(); ringInterval = window.setInterval(play, 1250);
  }
  function ringStop() { clearInterval(ringInterval); ringInterval = 0; }
  function callSignal(kind, extra = {}) {
    if (!call) return Promise.resolve();
    return window.otoBridge.chat.signal({kind, call_id:call.id, ...extra}, Number(call.peerId));
  }
  function showCall(mode) {
    const dialog = $('#callDialog');
    $('#callPeer').textContent = call?.peerName || 'Собеседник';
    $('#callIncomingActions').hidden = mode === 'active';
    $('#callActiveActions').hidden = mode !== 'active';
    $('#callAnswer').hidden = mode !== 'incoming';
    $('#callDecline').textContent = mode === 'outgoing' ? 'Отменить вызов' : 'Отклонить';
    $('#callTitle').textContent = mode === 'incoming' ? 'Входящий вызов' : mode === 'active' ? 'Голосовой вызов' : 'Вызов…';
    $('#callStatus').textContent = mode === 'incoming' ? 'ВХОДЯЩИЙ КАНАЛ' : mode === 'active' ? 'СВЯЗЬ УСТАНОВЛЕНА' : 'СОЕДИНЯЕМ…';
    $('#callTimer').hidden = mode !== 'active';
    if (!dialog.open) dialog.showModal();
  }
  function startCallClock() {
    if (callClock) return;
    call.startedAt = Date.now();
    callClock = window.setInterval(() => {
      if (!call) return;
      const seconds = Math.floor((Date.now() - call.startedAt) / 1000);
      $('#callTimer').textContent = `${String(Math.floor(seconds/60)).padStart(2,'0')}:${String(seconds%60).padStart(2,'0')}`;
    }, 500);
  }
  async function preparePeer() {
    call.stream = await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true},video:false});
    call.pc = new RTCPeerConnection({iceServers:[{urls:'stun:stun.l.google.com:19302'}]});
    call.stream.getTracks().forEach(track => call.pc.addTrack(track, call.stream));
    call.pc.onicecandidate = event => { if (event.candidate) void callSignal('ice', {candidate:event.candidate.toJSON()}); };
    call.pc.ontrack = event => { const audio = $('#remoteAudio'); audio.srcObject = event.streams[0]; void audio.play().catch(() => {}); };
    call.pc.onconnectionstatechange = () => {
      if (!call) return;
      if (call.pc.connectionState === 'connected') { ringStop(); clearTimeout(call.timeout); call.timeout = 0; showCall('active'); startCallClock(); }
      if (['failed','disconnected'].includes(call.pc.connectionState)) $('#callStatus').textContent = 'ВОССТАНАВЛИВАЕМ СВЯЗЬ';
    };
  }
  async function startCall() {
    if (!selectedRoom || selectedRoom.kind !== 'direct' || !selectedRoom.peer_id || call) return;
    ensureAudioContext();
    call = {id:crypto.randomUUID ? crypto.randomUUID() : String(Date.now()),peerId:Number(selectedRoom.peer_id),peerName:selectedRoom.peer_name,incoming:false,ice:[]};
    showCall('outgoing');
    try {
      await callSignal('ring'); ringStart();
      await preparePeer();
      const offer = await call.pc.createOffer();
      await call.pc.setLocalDescription(offer);
      await callSignal('offer', {description:call.pc.localDescription.toJSON()});
      call.timeout = window.setTimeout(() => { if (call) { void endCall(); toastIncoming('Голосовая связь','Нет ответа'); } }, 30000);
    } catch (error) { cleanupCall(); toastIncoming('Звонок не начался', error.name === 'NotAllowedError' ? 'Разрешите доступ к микрофону в настройках системы.' : window.otoBridge.errorMessage(error)); }
  }
  async function acceptCall() {
    if (!call?.incoming) return;
    ringStop();
    showCall('outgoing');
    try {
      await preparePeer();
      if (!call.offer) await new Promise((resolve,reject) => { call.waitOffer = resolve; setTimeout(() => reject(new Error('Собеседник не отправил предложение соединения')), 9000); });
      await call.pc.setRemoteDescription(new RTCSessionDescription(call.offer));
      for (const candidate of call.ice.splice(0)) await call.pc.addIceCandidate(new RTCIceCandidate(candidate));
      const answer = await call.pc.createAnswer();
      await call.pc.setLocalDescription(answer);
      await callSignal('answer', {description:call.pc.localDescription.toJSON()});
      showCall('outgoing');
    } catch (error) { toastIncoming('Не удалось ответить', window.otoBridge.errorMessage(error)); cleanupCall(); }
  }
  async function handleCallSignal(packet) {
    const data = packet?.payload || packet;
    if (!data || data.from_user_id == null || Number(data.from_user_id) === Number(identity.id)) return;
    const kind = data.kind, id = String(data.call_id || '');
    if (kind === 'ring') {
      if (call) { void window.otoBridge.chat.signal({kind:'busy',call_id:id}, Number(data.from_user_id)); return; }
      call = {id,peerId:Number(data.from_user_id),peerName:data.from_name || 'Собеседник',incoming:true,ice:[]};
      $('#chatRoomState').textContent = `Входящий звонок · ${call.peerName}`;
      showCall('incoming'); ringStart(); call.timeout = window.setTimeout(() => { if (call?.incoming) { void endCall('hangup'); toastIncoming('Голосовая связь','Время ожидания истекло'); } }, 30000); return;
    }
    if (!call || call.id !== id) return;
    if (kind === 'offer') { call.offer = data.description; if (call.waitOffer) call.waitOffer(); return; }
    if (kind === 'answer' && call.pc) {
      await call.pc.setRemoteDescription(new RTCSessionDescription(data.description));
      for (const candidate of call.ice.splice(0)) await call.pc.addIceCandidate(new RTCIceCandidate(candidate));
      return;
    }
    if (kind === 'ice' && data.candidate) {
      if (call.pc?.remoteDescription) await call.pc.addIceCandidate(new RTCIceCandidate(data.candidate)); else call.ice.push(data.candidate);
      return;
    }
    if (kind === 'hangup' || kind === 'decline' || kind === 'busy') {
      const text = kind === 'busy' ? 'Собеседник занят' : kind === 'decline' ? 'Вызов отклонён' : 'Звонок завершён';
      cleanupCall(); toastIncoming('Голосовая связь', text);
    }
  }
  function cleanupCall() {
    ringStop(); clearInterval(callClock); callClock = 0;
    if (call?.timeout) clearTimeout(call.timeout);
    if (call?.pc) { call.pc.onicecandidate = null; call.pc.ontrack = null; call.pc.close(); }
    call?.stream?.getTracks().forEach(track => track.stop());
    $('#remoteAudio').srcObject = null;
    if ($('#callDialog').open) $('#callDialog').close();
    call = null;
  }
  async function endCall(kind = 'hangup') {
    if (!call) return;
    const peerId = Number(call.peerId), callId = call.id;
    try { await window.otoBridge.chat.signal({kind,call_id:callId}, peerId); } catch (_) {}
    cleanupCall();
  }

  async function init() {
    try {
      const response = await window.otoBridge.get('/api/auth/me');
      identity = response.user;
      try {
        const persisted = JSON.parse(localStorage.getItem(`oto-chat-failed-${identity.id}`) || '[]');
        if (Array.isArray(persisted)) persisted.forEach(key => failedMessages.add(String(key)));
      } catch (_) {}
      const contactData = await window.otoBridge.get('/api/chat/contacts');
      contacts = contactData.contacts || [];
      renderStickerPicker();
      await refreshRooms();
      unlistenChat = await window.otoBridge.chat.listen((message, kind, senderId) => acceptMessage(message, kind, senderId).catch(console.error));
      unlistenCalls = await window.otoBridge.chat.listenCalls(handleCallSignal);
    } catch (error) { toastIncoming('Чат не подключён', window.otoBridge.errorMessage(error)); }

    $('#chatToggle').addEventListener('click', async () => {
      ensureAudioContext();
      const panel = $('#chatPanel');
      panel.hidden = false;
      requestAnimationFrame(() => panel.classList.add('open'));
      $('#chatToggle').setAttribute('aria-expanded','true');
      if (selectedRoom) await loadSelectedRoom();
    });
    $('#chatClose').addEventListener('click', () => { $('#chatPanel').classList.remove('open'); $('#chatToggle').setAttribute('aria-expanded','false'); setTimeout(() => { if (!$('#chatPanel').classList.contains('open')) $('#chatPanel').hidden = true; }, 220); });
    $('#chatRooms').addEventListener('click', async event => {
      const contact = event.target.closest('[data-contact-id]');
      const roomButton = event.target.closest('[data-room-id]');
      try {
        if (contact) await selectContact(Number(contact.dataset.contactId));
        else if (roomButton) { selectedRoom = rooms.find(room => Number(room.id) === Number(roomButton.dataset.roomId)); await loadSelectedRoom(); }
      } catch (error) { toastIncoming('Чат не открыт', window.otoBridge.errorMessage(error)); }
    });
    $('#chatForm').addEventListener('submit', event => { event.preventDefault(); send($('#chatInput').value).catch(error => toastIncoming('Не отправлено', window.otoBridge.errorMessage(error))); });
    $('#chatMessages').addEventListener('click', event => {
      const button = event.target.closest('[data-retry-message]');
      if (button) retryMessage(button.dataset.retryMessage).catch(error => toastIncoming('Не доставлено', window.otoBridge.errorMessage(error)));
    });
    $('#chatInput').addEventListener('input', event => { const field = event.currentTarget; field.style.height='auto'; field.style.height=`${Math.min(field.scrollHeight,112)}px`; });
    $('#chatStickerToggle').addEventListener('click', () => { $('#stickerPicker').hidden = !$('#stickerPicker').hidden; });
    const fileBtn = $('#chatFileBtn');
    const fileInput = $('#chatFileInput');
    if (fileBtn && fileInput) {
      fileBtn.addEventListener('click', () => fileInput.click());
      fileInput.addEventListener('change', async event => {
        const file = event.target.files?.[0];
        if (!file) return;
        try {
          const form = new FormData();
          form.append('file', file);
          const res = await fetch('/api/chat/upload', { method: 'POST', body: form });
          if (!res.ok) throw new Error('Ошибка загрузки файла');
          const data = await res.json();
          await send('', null, { url: data.url, type: data.media_type, name: data.media_name });
          fileInput.value = '';
        } catch (err) {
          toastIncoming('Файл не отправлен', window.otoBridge.errorMessage(err));
        }
      });
    }

    const voiceBtn = $('#chatVoiceBtn');
    let mediaRecorder = null;
    let voiceChunks = [];
    let voiceStart = 0;
    if (voiceBtn) {
      voiceBtn.addEventListener('click', async () => {
        if (!mediaRecorder || mediaRecorder.state === 'inactive') {
          try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            voiceChunks = [];
            voiceStart = Date.now();
            mediaRecorder = new MediaRecorder(stream);
            mediaRecorder.ondataavailable = e => { if (e.data.size > 0) voiceChunks.push(e.data); };
            mediaRecorder.onstop = async () => {
              stream.getTracks().forEach(t => t.stop());
              const blob = new Blob(voiceChunks, { type: 'audio/webm' });
              const duration = Math.max(1, Math.round((Date.now() - voiceStart) / 1000));
              try {
                const form = new FormData();
                form.append('file', blob, 'voice_note.webm');
                const res = await fetch('/api/chat/upload', { method: 'POST', body: form });
                if (!res.ok) throw new Error('Ошибка загрузки ГС');
                const data = await res.json();
                await send('', null, { url: data.url, type: 'audio_voice', name: `Голосовое сообщение (${duration}с)`, duration });
              } catch (err) {
                toastIncoming('ГС не отправлено', window.otoBridge.errorMessage(err));
              }
            };
            mediaRecorder.start();
            voiceBtn.style.color = '#ef4444';
            voiceBtn.title = 'Остановить запись';
            toastIncoming('Голосовое сообщение', 'Идёт запись... Нажмите ещё раз для отправки');
          } catch (err) {
            toastIncoming('Микрофон недоступен', window.otoBridge.errorMessage(err));
          }
        } else {
          mediaRecorder.stop();
          voiceBtn.style.color = '';
          voiceBtn.title = 'Голосовое сообщение';
        }
      });
    }
    $('#stickerPicker').addEventListener('click', event => { const button = event.target.closest('[data-sticker]'); if (button) send('', button.dataset.sticker).catch(error => toastIncoming('Стикер не отправлен', window.otoBridge.errorMessage(error))); });
    $('#chatCall').addEventListener('click', () => startCall().catch(error => toastIncoming('Не удалось позвонить', window.otoBridge.errorMessage(error))));
    $('#callAnswer').addEventListener('click', () => acceptCall());
    $('#callDecline').addEventListener('click', () => endCall(call?.incoming ? 'decline' : 'hangup'));
    $('#callMute').addEventListener('click', event => { if (!call?.stream) return; const enabled = call.stream.getAudioTracks().some(track => track.enabled); call.stream.getAudioTracks().forEach(track => { track.enabled = !enabled; }); event.currentTarget.setAttribute('aria-pressed', String(enabled)); event.currentTarget.textContent = enabled ? 'Включить микрофон' : 'Отключить микрофон'; });
    $('#callHangup').addEventListener('click', () => endCall());
    $('#callDialog').addEventListener('cancel', event => event.preventDefault());
    document.addEventListener('keydown', event => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); $('#chatToggle').click(); } });
  }
  window.otoChat = {
    handleRealtime(packet) {
      if (packet?.type === 'chat-message') acceptMessage(packet.payload, packet.room_kind, packet.payload?.from_user_id).catch(console.error);
      else if (packet?.type === 'chat-read') {
        const key = String(packet.payload?.relay_key || '');
        window.otoBridge.chat.markSentRead(key, Number(identity.id)).then(() => {
          if (messages.some(message => message.relay_key === key)) {
            const message = messages.find(item => item.relay_key === key);
            if (message) message.read = 1;
            renderMessages();
          }
        }).catch(() => {});
      }
      else if (packet?.type === 'call-signal') handleCallSignal(packet).catch(console.error);
    },
  };
  window.addEventListener('beforeunload', () => { unlistenChat?.(); unlistenCalls?.(); cleanupCall(); });
  init();
})();
