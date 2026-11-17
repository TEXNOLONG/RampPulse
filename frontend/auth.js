/* Вход и регистрация инженера */
const $ = (s, r = document) => r.querySelector(s);

let META = null;
let lastRegisteredEmail = "";
const startupStartedAt = performance.now();

async function finishStartup() {
  const status = $('#authBootStatus');
  const progress = $('#authBootProgress');
  if (status) status.textContent = 'CLEAR FOR TAKEOFF: Готово к взлёту';
  if (progress) progress.style.transform = 'scaleX(1)';
  const bar = progress?.closest('.boot-progress');
  if (bar) bar.setAttribute('aria-valuenow', '100');
  const percent = $('#authBootProgressPercent');
  if (percent) percent.textContent = '100%';
  document.querySelectorAll('[data-auth-stage]').forEach(node => {
    const stage = Number(node.dataset.authStage);
    node.classList.toggle('active', stage === 2);
    node.classList.toggle('done', stage < 2);
  });
  const nativeSplashAlreadyShown = await window.otoBridge.consumeDesktopStartup().catch(() => false);
  await window.otoBridge.revealSplash('authStartup', startupStartedAt, nativeSplashAlreadyShown ? 0 : 1800);
  document.body.classList.remove('auth-starting');
}

function showMessage(node, text, kind = 'bad') {
  if (!node) return;
  node.textContent = text;
  node.className = 'form-message ' + kind;
  node.hidden = false;
  node.tabIndex = -1;
  node.focus();
}

function clearMessage(node) {
  if (!node) return;
  node.textContent = '';
  node.hidden = true;
}

async function request(path, body) {
  return window.otoBridge.post(path, body);
}

function setBusy(button, busy, text) {
  if (!button) return;
  button.disabled = busy;
  if (busy) {
    button.dataset.label = button.textContent;
    button.textContent = text || 'Подождите…';
  } else if (button.dataset.label) {
    button.textContent = button.dataset.label;
  }
}

function setMode(mode) {
  const login = mode !== 'register';
  document.body.classList.toggle('auth-registering', !login);
  $('#loginPane').hidden = !login;
  $('#registerPane').hidden = login;
  $('#successPane').hidden = true;
  document.querySelectorAll('[data-auth-tab]').forEach(button => {
    button.classList.toggle('on', button.dataset.authTab === mode);
    button.setAttribute('aria-selected', String(button.dataset.authTab === mode));
  });
  const url = new URL(location.href);
  if (login) url.searchParams.delete('mode');
  else url.searchParams.set('mode', 'register');
  history.replaceState(null, '', url);
}

async function demoLogin(email, password, button) {
  const msg = $('#loginMsg');
  clearMessage(msg);
  setBusy(button, true, 'Входим…');
  try {
    const data = await request('/api/auth/login', { email, password });
    location.replace(data.redirect || '/');
  } catch (e) {
    showMessage(msg, e.message, 'bad');
    setBusy(button, false);
  }
}

function fillMeta() {
  if (!META) return;
  const qual = $('#regQual');
  const base = $('#regBase');
  const chips = $('#typeChips');
  qual.innerHTML = META.quals.map(q => `<option>${q}</option>`).join('');
  base.innerHTML = META.bases.map(b => `<option value="${b.id}">${b.name}</option>`).join('');
  chips.innerHTML = META.types.map((type, i) => `
    <label class="type-chip">
      <input type="checkbox" name="types" value="${type}" ${i === 0 ? 'checked' : ''}>
      <span>${type}</span>
    </label>`).join('');

  if (META.demo && META.demo.enabled) {
    const box = $('#demoBox');
    const dr = $('#demoDispatcher');
    const en = $('#demoEngineer');
    if (dr) dr.textContent = `${META.demo.dispatcher_email} / ${META.demo.dispatcher_password}`;
    if (en) en.textContent = `${META.demo.engineer_email} / ${META.demo.engineer_password}`;
    if (box) box.hidden = false;
  }
}

async function init() {
  const status = $('#authBootStatus');
  const progress = $('#authBootProgress');
  if (status) status.textContent = 'PRE-FLIGHT CHECK: Инициализация систем…';
  if (progress) progress.style.transform = 'scaleX(.42)';
  const bar = progress?.closest('.boot-progress');
  if (bar) bar.setAttribute('aria-valuenow', '42');
  const percent = $('#authBootProgressPercent');
  if (percent) percent.textContent = '42%';
  document.querySelectorAll('[data-auth-stage]').forEach(node => {
    const stage = Number(node.dataset.authStage);
    node.classList.toggle('active', stage === 1);
    node.classList.toggle('done', stage < 1);
  });
  try {
    if (status) status.textContent = 'RADAR & COMMS: Подключение модулей связи…';
    META = await window.otoBridge.get('/api/meta');
    fillMeta();
    if (status) status.textContent = 'CABIN READY: Загрузка интерфейса…';
    if (progress) progress.style.transform = 'scaleX(.82)';
    if (bar) bar.setAttribute('aria-valuenow', '82');
    if (percent) percent.textContent = '82%';
  } catch (e) {
    showMessage($('#loginMsg'), 'Сервер недоступен. Проверьте, что он запущен.', 'bad');
    if (status) status.textContent = 'RADAR & COMMS: Сервис не отвечает · проверьте запуск';
  }

  const mode = new URLSearchParams(location.search).get('mode');
  setMode(mode === 'register' ? 'register' : 'login');

  if (META?.demo?.enabled) {
    const d = $('#demoDispatcherBtn');
    const e = $('#demoEngineerBtn');
    if (d) d.addEventListener('click', () => demoLogin(META.demo.dispatcher_email, META.demo.dispatcher_password, d));
    if (e) e.addEventListener('click', () => demoLogin(META.demo.engineer_email, META.demo.engineer_password, e));
  }

  document.querySelectorAll('[data-auth-tab]').forEach(button => {
    button.addEventListener('click', () => setMode(button.dataset.authTab));
  });
  $('#openRegister').addEventListener('click', () => {
    setMode('register');
    $('#regName').focus();
  });

  document.querySelectorAll('[data-password-toggle]').forEach(button => {
    button.addEventListener('click', () => {
      const input = document.getElementById(button.dataset.passwordToggle);
      if (!input) return;
      const visible = input.type === 'password';
      input.type = visible ? 'text' : 'password';
      button.setAttribute('aria-pressed', String(visible));
      button.setAttribute('aria-label', visible ? 'Скрыть пароль' : 'Показать пароль');
      input.focus();
    });
  });

  $('#loginForm').addEventListener('submit', async event => {
    event.preventDefault();
    const msg = $('#loginMsg');
    clearMessage(msg);
    const button = $('#loginSubmit');
    setBusy(button, true, 'Входим…');
    try {
      const data = await request('/api/auth/login', {
        email: $('#loginEmail').value.trim(),
        password: $('#loginPassword').value,
      });
      location.replace(data.redirect || '/');
    } catch (e) {
      showMessage(msg, e.message, 'bad');
      setBusy(button, false);
    }
  });

  $('#registerForm').addEventListener('submit', async event => {
    event.preventDefault();
    const msg = $('#registerMsg');
    clearMessage(msg);
    const types = [...document.querySelectorAll('input[name="types"]:checked')].map(x => x.value);
    if (!types.length) {
      showMessage(msg, 'Выберите хотя бы один тип воздушного судна', 'bad');
      return;
    }
    const button = $('#registerSubmit');
    setBusy(button, true, 'Отправляем…');
    try {
      const email = $('#regEmail').value.trim();
      const data = await request('/api/auth/register', {
        name: $('#regName').value.trim(),
        username: $('#regUsername').value.trim().toLowerCase(),
        email,
        password: $('#regPassword').value,
        qual: $('#regQual').value,
        types,
        base: $('#regBase').value,
      });
      lastRegisteredEmail = email;
      $('#loginPane').hidden = true;
      $('#registerPane').hidden = true;
      $('#successPane').hidden = false;
      document.querySelectorAll('[data-auth-tab]').forEach(b => b.classList.remove('on'));
      const successText = $('#successPane p');
      if (successText) successText.textContent = data.message;
    } catch (e) {
      showMessage(msg, e.message, 'bad');
      setBusy(button, false);
    }
  });

  $('#successLogin').addEventListener('click', () => {
    setMode('login');
    if (lastRegisteredEmail) $('#loginEmail').value = lastRegisteredEmail;
    $('#loginPassword').focus();
  });
}

init().finally(finishStartup);
