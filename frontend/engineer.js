/* Личное приложение инженера */
const $ = (s, r = document) => r.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmt = sec => {
  if (sec == null) return '—';
  sec = Math.max(0, Math.round(sec));
  return String(Math.floor(sec / 60)).padStart(2, '0') + ':' + String(sec % 60).padStart(2, '0');
};
const QCOL = {'Планер': 'var(--glider)', 'Двигатель': 'var(--engine)', 'Авионика': 'var(--avionics)'};
const ACTION = {
  enroute: ['arrive', 'Я на месте'],
  arrived: ['start', 'Начать работу'],
  working: ['resolve', 'Работа выполнена'],
};

let AIR = null, S = null, ws = null, reconnectTimer = null;
let shouldReconnect = true;
let retry = 0;
const busy = new Set();

function engBootStage(stage, detail) {
  const messages = [
    'PRE-FLIGHT CHECK: Инициализация систем…',
    'RADAR & COMMS: Подключение модулей связи…',
    'CABIN READY: Загрузка интерфейса…',
    'CLEAR FOR TAKEOFF: Готово к взлёту',
  ];
  const status = $('#engBootStatus');
  const progress = $('#engBootProgress');
  const values = [8, 42, 76, 100];
  if (status) status.textContent = messages[stage] || detail;
  if (progress) progress.style.transform = `scaleX(${values[stage] / 100})`;
  const bar = progress?.closest('.boot-progress');
  if (bar) bar.setAttribute('aria-valuenow', String(values[stage]));
  const percent = $('#engBootProgressPercent');
  if (percent) percent.textContent = `${String(values[stage]).padStart(2, '0')}%`;
  document.querySelectorAll('[data-eng-stage]').forEach(node => {
    const current = Number(node.dataset.engStage);
    node.classList.toggle('active', current === stage);
    node.classList.toggle('done', current < stage);
  });
}

function toast(text, bad = false) {
  const t = $('#engToast');
  if (!t) return;
  t.textContent = text;
  t.className = 'toast' + (bad ? ' bad' : '');
  t.hidden = false;
  clearTimeout(toast.h);
  toast.h = setTimeout(() => { t.hidden = true; }, 3500);
}

async function api(path, body) {
  return window.otoBridge.post(path, body);
}

function setConnection(on) {
  const el = $('#engConn');
  if (!el) return;
  el.className = 'eng-conn ' + (on ? 'on' : 'off');
  el.querySelector('span').textContent = on ? 'Онлайн' : 'Нет связи';
}

function handleOperationEvent(packet) {
  const kind = packet?.kind;
  if (!kind) return false;
  if (kind === 'heartbeat_ack') return true;
  if (kind === 'chat_message_created') {
    const message = packet.payload || {};
    window.otoChat?.handleRealtime({type:'chat-message',room_kind:message.room_kind,payload:{...message,from_user_id:message.sender_id}});
    return true;
  }
  if (kind === 'chat_message_read') {
    window.otoChat?.handleRealtime({type:'chat-read',payload:packet.payload || {}});
    return true;
  }
  if (kind.startsWith('call_')) {
    window.otoChat?.handleRealtime({type:'call-signal',payload:{...(packet.payload || {}),kind:packet.payload?.kind || ({call_invited:'ring',call_accepted:'answer',call_rejected:'decline',call_ended:'hangup'}[kind] || 'signal')}});
    return true;
  }
  if (kind === 'state_delta' && packet.entity?.kind === 'simulation' && S) {
    const previousSimTime = Number(S.sim_time || 0);
    const {aircraft: aircraftDeltas = [], techs: techDeltas = [], ...simulation} = packet.payload || {};
    Object.assign(S, simulation);
    const ownTechDelta = techDeltas.find(tech => Number(tech.id) === Number(S.me?.id));
    if (ownTechDelta && S.me) {
      const routeWasAvailable = S.me.route_available !== false;
      Object.assign(S.me, ownTechDelta);
      if (routeWasAvailable && ownTechDelta.route_available === false) toast('Маршрут перекрыт. Диспетчер перестраивает путь.', true);
      const activeRequest = (S.active || []).find(request => Number(request.id) === Number(ownTechDelta.request_id));
      if (activeRequest) activeRequest.eta_left = ownTechDelta.eta_left;
      updateEngineerMapPosition();
    }
    const simStep = Math.max(0, Number(S.sim_time || 0) - previousSimTime);
    if (simStep > 0) {
      const deltas = new Map(aircraftDeltas.map(aircraft => [Number(aircraft.id), aircraft]));
      for (const aircraft of (S.aircraft || [])) {
        const delta = deltas.get(Number(aircraft.id));
        if (!delta) continue;
        aircraft.turnaround_progress = delta.turnaround_progress;
        aircraft.services_progress = delta.services_progress;
        if (aircraft.status !== delta.status) {
          aircraft.status = delta.status;
          aircraft.status_ru = delta.status_ru;
        }
      }
      for (const request of (S.active || [])) {
        if (request.status === 'waiting' || request.status === 'enroute' || request.status === 'assigned') {
          request.elapsed = Number(request.elapsed || 0) + simStep;
          if (request.status !== 'waiting' && request.eta_left != null &&
              !(ownTechDelta && Number(request.id) === Number(ownTechDelta.request_id))) {
            request.eta_left = Math.max(0, Number(request.eta_left) - simStep);
          }
        }
      }
      renderLiveTasks();
    }
    return true;
  }
  if (kind === 'connection_ready' || kind === 'resync_required' || kind === 'state_snapshot' ||
      kind === 'state_delta' || kind.startsWith('request_') || kind.startsWith('registration_') ||
      kind === 'shift_started' || kind === 'shift_ended' || kind === 'presence_changed' ||
      kind === 'route_blocked' || kind === 'route_cleared') {
    void loadState();
    return true;
  }
  return true;
}

function connect() {
  clearTimeout(reconnectTimer);
  if (!shouldReconnect) return;
  try {
    ws = window.otoBridge.socket('/ws');
    ws.onopen = () => { retry = 0; setConnection(true); };
    ws.onmessage = event => {
      try {
        const packet = JSON.parse(event.data);
        if (packet?.protocol && handleOperationEvent(packet)) return;
        if (packet?.type && window.otoChat) window.otoChat.handleRealtime(packet);
        else { S = packet; render(); }
      } catch (e) {
        console.error('Некорректное сообщение WebSocket', e);
      }
    };
    ws.onclose = event => {
      setConnection(false);
      if (event.code === 4401) {
        shouldReconnect = false;
        location.replace('/login?next=/engineer');
        return;
      }
      const delay = Math.min(1000 * Math.pow(1.7, retry++), 15000);
      reconnectTimer = setTimeout(connect, delay);
    };
    ws.onerror = () => {};
  } catch (e) {
    setConnection(false);
    reconnectTimer = setTimeout(connect, 3000);
  }
}

async function loadState() {
  try {
    S = await window.otoBridge.get('/api/state');
    render();
  } catch (e) {
    toast(e.message, true);
  }
}

function baseName(id) {
  const b = (AIR && AIR.bases || []).find(x => x.id === id);
  return b ? b.name : (id || '—');
}

function renderHeader() {
  const account = S.account || {};
  const me = S.me || {};
  const name = account.name || me.name || 'Инженер';
  const initial = name.trim().slice(0, 1).toUpperCase() || 'И';
  $('#engName').textContent = name;
  $('#engAvatar').textContent = initial;
  $('#engProfileMark').textContent = initial;
  $('#engProfileName').textContent = name;
  const airport = S.airport_name || (AIR && AIR.name) || 'Смена';
  $('#engAirport').textContent = airport;
  $('#engSub').textContent = [
    account.qual || me.qual || '—',
    'База: ' + baseName(account.base || me.base),
    account.email || '',
  ].filter(Boolean).join(', ');
}

function renderStats() {
  const st = S.stats || {};
  const cards = [
    [st.active ?? 0, 'активных'],
    [st.done ?? 0, 'выполнено'],
    [st.norm_pct == null ? '—' : st.norm_pct + '%', 'в норматив'],
    [st.avg_response == null ? '—' : fmt(st.avg_response), 'среднее прибытие'],
  ];
  $('#engStats').innerHTML = cards.map(([value, label]) =>
    `<div class="eng-stat"><b>${esc(value)}</b><span>${esc(label)}</span></div>`
  ).join('');
}

function aircraftFor(r) {
  return (S.aircraft || []).find(a => a.id === r.aircraft_id) || null;
}

function taskCard(r) {
  const em = r.priority === 'emergency';
  const action = ACTION[r.status];
  const activeStep = r.status === 'enroute' ? 2 : r.status === 'arrived' ? 3 : r.status === 'working' ? 4 : 1;
  const aircraft = aircraftFor(r);
  const eta = r.status === 'enroute' ? fmt(r.eta_left) : null;
  const elapsed = r.elapsed != null ? r.elapsed : 0;
  const norm = S.norm || 900;
  const progress = Math.min(100, Math.max(0, elapsed / norm * 100));
  const barCls = elapsed > norm ? 'over' : '';
  const left = r.status === 'enroute' ? 'До прибытия' : r.status === 'arrived' ? 'На стоянке' : 'В работе';
  const flight = r.flight || (aircraft && aircraft.flight) || '—';
  return `<article class="eng-task st-${esc(r.status)}${em ? ' em' : ''}${elapsed > norm ? ' st-overdue' : ''}" data-task="${r.id}">
    <header class="eng-task-head">
      <span class="eng-task-id">#${r.id}</span>
      <span class="eng-task-stand">${esc(r.stand)}</span>
      <span class="eng-badge st-${esc(r.status)}">${esc(r.status_ru)}</span>
      ${em ? '<span class="eng-badge em">ЧС</span>' : ''}
    </header>
    <h3>${esc(r.description)}</h3>
    ${r.extra ? `<p class="eng-task-extra">${esc(r.extra)}</p>` : ''}
    <div class="eng-task-facts">
      <div><span>Рейс</span><b>${esc(flight)}</b></div>
      <div><span>Квалификация</span><b>${esc(r.qual)}</b></div>
      <div><span>${left}</span><b data-live="task-eta" data-id="${r.id}">${eta || (r.status === 'working' ? fmt(elapsed) : '—')}</b></div>
    </div>
    ${r.note ? `<p class="eng-task-note">${esc(r.note)}</p>` : ''}
    <div class="eng-progress" title="Время с момента вызова">
      <i data-live="task-progress" data-id="${r.id}" class="${barCls}" style="width:${progress}%"></i>
    </div>
    <div class="eng-task-foot">
      <span class="eng-elapsed">С момента вызова: <b data-live="task-elapsed" data-id="${r.id}">${fmt(elapsed)}</b></span>
      ${action ? `<button class="primary eng-action" data-eng-act="${action[0]}" data-id="${r.id}"
        ${busy.has(`${r.id}:${action[0]}`) ? 'disabled' : ''}>
        ${busy.has(`${r.id}:${action[0]}`) ? 'Сохраняем…' : (action[0] === 'arrive' ? 'На месте' : action[0] === 'resolve' ? 'Завершено' : action[1])}</button>` : ''}
    </div>
    <div class="eng-steps" aria-label="Этапы выполнения">${['Принял','В пути','На месте','Завершено'].map((label, i) => `<div class="eng-step ${i + 1 < activeStep ? 'done' : ''} ${i + 1 === activeStep ? 'current' : ''}"><i>${i + 1 < activeStep ? '✓' : i + 1}</i><span>${label}</span></div>`).join('')}</div>
  </article>`;
}

function renderTasks() {
  const tasks = S.active || [];
  const hint = $('#engTaskHint');
  if (hint) hint.textContent = tasks.length
    ? `Назначено: ${tasks.length}. Отмечайте этапы по мере работы.`
    : 'Активных назначений нет';
  $('#engTasks').innerHTML = tasks.length
    ? tasks.map(taskCard).join('')
    : `<div class="eng-free">
        <div class="eng-free-mark"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4.2 4.2L19 6.5"/></svg></div>
        <div><b>Вы свободны</b>
        <p>Диспетчер назначит заявку автоматически — по квалификации, допуску на тип ВС и ближайшему маршруту.</p></div>
      </div>`;
}

function renderLiveTasks() {
  const norm = Number(S.norm || 900);
  for (const request of (S.active || [])) {
    const id = Number(request.id);
    const elapsed = Number(request.elapsed || 0);
    const eta = request.status === 'enroute' ? fmt(request.eta_left) : request.status === 'working' ? fmt(elapsed) : '—';
    const etaNode = $(`[data-live="task-eta"][data-id="${id}"]`);
    const elapsedNode = $(`[data-live="task-elapsed"][data-id="${id}"]`);
    const progressNode = $(`[data-live="task-progress"][data-id="${id}"]`);
    if (etaNode) etaNode.textContent = eta;
    if (elapsedNode) elapsedNode.textContent = fmt(elapsed);
    if (progressNode) {
      progressNode.style.width = `${Math.min(100, Math.max(0, elapsed / norm * 100))}%`;
      progressNode.classList.toggle('over', elapsed > norm);
    }
  }
}

function renderHistory() {
  const items = (S.history || []).slice(0, 10);
  $('#engHistory').innerHTML = items.length ? items.map(r => `
    <div class="eng-history-row">
      <span class="eng-history-id">#${r.id}</span>
      <span class="eng-history-stand">${esc(r.stand)}</span>
      <span class="eng-history-desc">${esc(r.description)}</span>
      <span class="eng-badge st-${esc(r.status)}">${esc(r.status_ru)}</span>
    </div>`).join('')
    : '<p class="empty small">Пока нет выполненных заявок.</p>';
}

function renderEvents() {
  const events = (S.events || []).slice(0, 16);
  $('#engEvents').innerHTML = events.length ? events.map(e => `
    <div class="eng-event ${esc(e.kind || '')}">
      <time>${esc(e.ts)}</time>
      <span>${esc(e.text)}</span>
    </div>`).join('')
    : '<p class="empty small">События появятся после назначения заявки.</p>';
}

function renderMap() {
  const svg = $('#engMap');
  const empty = $('#engMapEmpty');
  if (!svg || !AIR) return;
  const me = S.me;
  if (!me) {
    svg.innerHTML = '';
    if (empty) empty.hidden = false;
    return;
  }

  const active = (S.active || [])[0] || null;
  const vehicle = (S.vehicles || []).find(v => v.tech_id === me.id) || null;
  const vehicleRoutePts = vehicle ? (vehicle.route || []).map(p => [p[0], p[1]]) : [];
  const routePts = (me.route || []).map(p => [p[0], p[1]]);
  const points = [];
  if (me.x != null && me.y != null) points.push([me.x, me.y]);
  routePts.forEach(p => points.push(p));
  if (vehicle) {
    points.push([vehicle.x, vehicle.y]);
    vehicleRoutePts.forEach(p => points.push(p));
  }

  let stand = null, standNode = null;
  if (active) {
    stand = (AIR.stands || []).find(s => s.id === active.stand);
    if (stand && stand.node != null) {
      standNode = (AIR.nodes || []).find(n => n.id === stand.node);
      if (standNode) points.push([standNode.x, standNode.y]);
    }
  }
  if (!points.length) {
    svg.innerHTML = '';
    if (empty) empty.hidden = false;
    return;
  }
  if (empty) empty.hidden = true;

  const xs = points.map(p => p[0]), ys = points.map(p => p[1]);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  let w = Math.max(maxX - minX, 170) + 180;
  let h = Math.max(maxY - minY, 100) + 180;
  const ar = 600 / 260;
  if (w / h < ar) w = h * ar; else h = w / ar;
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  const vx = cx - w / 2, vy = cy - h / 2;
  svg.setAttribute('viewBox', `${vx} ${vy} ${w} ${h}`);

  const N = Object.fromEntries((AIR.nodes || []).map(n => [n.id, n]));
  const inBox = p => p && p.x >= vx - 220 && p.x <= vx + w + 220 && p.y >= vy - 220 && p.y <= vy + h + 220;
  const edgeW = Math.max(2, w / 240);
  const edges = (AIR.edges || []).filter(e => inBox(N[e.a]) && inBox(N[e.b])).map(e => {
    const a = N[e.a], b = N[e.b];
    const kind = e.kind === 'runway' ? 'eng-map-rwy' : 'eng-map-edge';
    return `<line class="${kind}" x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" stroke-width="${e.kind === 'runway' ? edgeW * 4 : edgeW}"/>`;
  }).join('');

  const fs = w / 34;
  const sr = Math.max(8, w / 26);
  const stands = (AIR.stands || []).map(s => {
    const n = N[s.node];
    if (!inBox(n)) return '';
    const isActive = active && s.id === active.stand;
    return `<g class="eng-map-stand${isActive ? ' sel' : ''}">
      <rect x="${n.x - sr / 2}" y="${n.y - sr * 0.58}" width="${sr}" height="${sr * 1.16}"/>
      <text x="${n.x}" y="${n.y + sr * 1.45}" text-anchor="middle" font-size="${fs * 0.62}">${esc(s.id)}</text>
    </g>`;
  }).join('');

  const routeStr = [[me.x, me.y], ...routePts].map(p => p.join(',')).join(' ');
  const hasRoute = routePts.length > 1;
  const route = hasRoute
    ? `<polyline class="eng-route-casing" points="${routeStr}"/>
       <polyline class="eng-route-line" points="${routeStr}"/>`
    : '';

  const vehicleRouteStr = vehicle ? [[vehicle.x, vehicle.y], ...vehicleRoutePts].map(p => p.join(',')).join(' ') : '';
  const vehicleRouteHtml = vehicleRoutePts.length > 1
    ? `<polyline class="eng-vehicle-route-casing" points="${vehicleRouteStr}"/>
       <polyline class="eng-vehicle-route" points="${vehicleRouteStr}"/>`
    : '';
  const vehicleR = Math.max(10, w / 42);
  const vehicleHtml = vehicle ? `
    <g class="eng-vehicle" transform="translate(${vehicle.x} ${vehicle.y}) rotate(${vehicle.heading || 0})">
      <circle class="eng-vehicle-ring" r="${vehicleR * 1.65}"/>
      <rect class="eng-vehicle-body" x="${-vehicleR * .55}" y="${-vehicleR}" width="${vehicleR * 1.1}" height="${vehicleR * 2}" rx="${vehicleR * .22}"/>
      <rect class="eng-vehicle-glass" x="${-vehicleR * .38}" y="${-vehicleR * .63}" width="${vehicleR * .76}" height="${vehicleR * .42}" rx="${vehicleR * .1}"/>
      <path class="eng-vehicle-beacon" d="M ${-vehicleR * .2} ${-vehicleR * .08} h ${vehicleR * .4}"/>
      <text class="eng-vehicle-label" x="0" y="${vehicleR * 1.55}" text-anchor="middle" font-size="${fs * .68}">М${vehicle.id}</text>
    </g>` : '';

  const standHtml = standNode ? `
    <rect class="eng-stand-ring" x="${standNode.x - sr * 1.15}" y="${standNode.y - sr * 1.3}"
      width="${sr * 2.3}" height="${sr * 2.6}"/>
    <text class="eng-stand-label" x="${standNode.x}" y="${standNode.y + sr * 2.4}"
      text-anchor="middle" font-size="${fs * 1.05}">${esc(active.stand)}</text>` : '';

  const meR = Math.max(7, w / 50);
  svg.innerHTML = `
    <g class="eng-map-context">${edges}${stands}</g>
    ${route}
    ${vehicleRouteHtml}
    ${standHtml}
    ${vehicleHtml}
    <circle class="eng-me-ring" cx="${me.x}" cy="${me.y}" r="${meR * 2.2}"/>
    <circle class="eng-me${me.route_available === false ? ' route-unavailable' : ''}" cx="${me.x}" cy="${me.y}" r="${meR}" style="fill:${QCOL[me.qual] || 'var(--blue)'}"/>
    <text class="eng-me-label" data-offset="${meR * 2.9}" x="${me.x}" y="${me.y - meR * 2.9}" text-anchor="middle" font-size="${fs * 0.78}">Вы</text>`;
}

function updateEngineerMapPosition() {
  const svg = $('#engMap');
  const me = S?.me;
  if (!svg || !me) return;
  svg.querySelector('.eng-me')?.setAttribute('cx', String(me.x));
  svg.querySelector('.eng-me')?.setAttribute('cy', String(me.y));
  svg.querySelector('.eng-me')?.classList.toggle('route-unavailable', me.route_available === false);
  svg.querySelector('.eng-me-ring')?.setAttribute('cx', String(me.x));
  svg.querySelector('.eng-me-ring')?.setAttribute('cy', String(me.y));
  const label = svg.querySelector('.eng-me-label');
  if (label) { label.setAttribute('x', String(me.x)); label.setAttribute('y', String(me.y - Number(label.dataset.offset || 20))); }
  const routePoints = me.route?.length ? me.route.slice() : [];
  if (routePoints.length) routePoints[0] = [me.x, me.y];
  else routePoints.push([me.x, me.y]);
  const route = routePoints.map(p => `${p[0]} ${p[1]}`).join(' ');
  svg.querySelectorAll('.eng-route-casing, .eng-route-line').forEach(line => line.setAttribute('points', route));
}

function render() {
  if (!S) return;
  renderHeader();
  renderShiftControl();
  renderStats();
  renderTasks();
  renderHistory();
  renderEvents();
  renderMap();
}

function renderShiftControl() {
  const button = $('#engShiftToggle');
  if (!button) return;
  const account = S.account || S.me || {};
  const onShift = Boolean(account.on_shift ?? S.me?.on_shift ?? true);
  button.textContent = onShift ? 'Завершить смену' : 'Выйти на смену';
  button.classList.toggle('off-shift', !onShift);
  button.setAttribute('aria-pressed', String(onShift));
  const mark = $('#engProfileMark');
  if (mark) mark.title = onShift ? 'На смене' : 'Не на смене';
}

async function act(button) {
  const key = `${button.dataset.id}:${button.dataset.engAct}`;
  if (busy.has(key)) return;
  busy.add(key);
  button.disabled = true;
  const label = button.textContent;
  button.textContent = 'Сохраняем…';
  try {
    await api(`/api/engineer/requests/${button.dataset.id}/${button.dataset.engAct}`, {});
    toast('Статус обновлён');
    await loadState();
  } catch (e) {
    toast(e.message, true);
  } finally {
    busy.delete(key);
    if (button.isConnected) {
      button.disabled = false;
      button.textContent = label;
    }
  }
}

async function init() {
  const startupAt = performance.now();
  engBootStage(0);
  try {
    AIR = await window.otoBridge.airport();
    engBootStage(1);
    await loadState();
    engBootStage(2);
    connect();
    engBootStage(3);
    const nativeSplashAlreadyShown = await window.otoBridge.consumeDesktopStartup().catch(() => false);
    await window.otoBridge.revealSplash('engStartup', startupAt, nativeSplashAlreadyShown ? 0 : 1800);
  } catch (e) {
    const message = 'Не удалось запустить приложение: ' + window.otoBridge.errorMessage(e);
    const status = $('#engBootStatus');
    if (status) status.textContent = message;
    const splash = $('#engStartup');
    if (splash) splash.classList.add('is-error');
    const retry = $('#engBootRetry');
    if (retry) { retry.hidden = false; retry.onclick = () => location.reload(); }
  }

  $('#engLogout').addEventListener('click', async () => {
    shouldReconnect = false;
    clearTimeout(reconnectTimer);
    try { await api('/api/auth/logout', {}); } catch (_) {}
    location.replace('/login');
  });

  const newSession = $('#newSession');
  if (newSession) newSession.addEventListener('click', async () => {
    newSession.disabled = true;
    try { await window.otoBridge.openSession(); }
    catch (error) { toast(window.otoBridge.errorMessage(error), true); }
    finally { newSession.disabled = false; }
  });

  $('#engRefresh').addEventListener('click', () => loadState());
  document.querySelectorAll('[data-logout-trigger]').forEach(button => button.addEventListener('click', () => $('#engLogout').click()));
  $('#engShiftToggle').addEventListener('click', () => {
    const account = S?.account || S?.me || {};
    if (Boolean(account.on_shift ?? S?.me?.on_shift ?? true)) {
      $('#shiftError').hidden = true;
      $('#shiftTitle').textContent = 'Завершить смену?';
      $('#shiftConfirmText').textContent = 'Вы покинете активную смену. Если за вами закреплена незавершённая заявка, завершить её сейчас нельзя.';
      $('#shiftDlg').showModal();
    } else {
      api('/api/engineer/shift/start', {}).then(loadState).catch(error => toast(window.otoBridge.errorMessage(error), true));
    }
  });
  $('#shiftCancel').addEventListener('click', () => $('#shiftDlg').close());
  $('#shiftConfirm').addEventListener('click', async () => {
    const error = $('#shiftError');
    error.hidden = true;
    try {
      await api('/api/engineer/shift/end', {});
      $('#shiftDlg').close();
      await loadState();
    } catch (e) {
      error.textContent = window.otoBridge.errorMessage(e);
      error.hidden = false;
    }
  });
  $('#routeOpen').addEventListener('click', () => window.open('/', '_self'));

  document.addEventListener('click', event => {
    const button = event.target.closest('[data-eng-act]');
    if (button) act(button);
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') loadState();
  });
}

init();
