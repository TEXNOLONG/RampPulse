(() => {
  const statuses = [
    'PRE-FLIGHT CHECK: Инициализация систем…',
    'RADAR & COMMS: Подключение модулей связи…',
    'CABIN READY: Загрузка интерфейса…',
    'CLEAR FOR TAKEOFF: Готово к взлёту',
  ];
  const values = [8, 42, 76, 100];
  const status = document.getElementById('desktopBootStatus');
  const progress = document.getElementById('desktopBootProgress');
  const bar = document.getElementById('desktopBootBar');
  const percent = document.getElementById('desktopBootPercent');
  const setStage = (stage, message) => {
    const current = Math.max(0, Math.min(3, Number(stage) || 0));
    if (status) status.textContent = message || statuses[current];
    if (progress) progress.style.transform = `scaleX(${values[current] / 100})`;
    if (bar) bar.setAttribute('aria-valuenow', String(values[current]));
    if (percent) percent.textContent = `${String(values[current]).padStart(2, '0')}%`;
    document.querySelectorAll('[data-stage]').forEach(node => {
      const index = Number(node.dataset.stage);
      node.classList.toggle('active', index === current);
      node.classList.toggle('done', index < current);
    });
  };

  const api = window.__TAURI__;
  const log = message => {
    try { void api?.core?.invoke?.('write_client_diagnostic', { message: `[native splash] ${message}` }); }
    catch (error) { console.error('RampPulse splash log failed', error); }
  };
  const flightVideo = document.querySelector('.flight-video');
  const splash = document.querySelector('.boot-screen.video-only');
  const revealStatus = () => splash?.classList.add('show-status');
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  log(`opened href=${location.href} video=${flightVideo?.currentSrc || flightVideo?.querySelector('source')?.src || 'missing'}`);
  const syncMotionPreference = () => {
    if (!flightVideo) return;
    if (reducedMotion.matches) flightVideo.pause();
    else void flightVideo.play().catch(() => {});
  };
  syncMotionPreference();
  reducedMotion.addEventListener?.('change', syncMotionPreference);
  if (flightVideo) {
    flightVideo.addEventListener('ended', () => { log('intro video ended'); flightVideo.pause(); }, { once: true });
    flightVideo.addEventListener('error', () => {
      log(`intro video error code=${flightVideo.error?.code || 'unknown'}`);
      revealStatus();
      setStage(1, 'RADAR & COMMS: Не удалось запустить видео. Проверяем интерфейс…');
    }, { once: true });
  }
  const close = document.getElementById('splashClose');
  if (close) close.addEventListener('click', async () => {
    try { await api?.window?.getCurrentWindow?.().close(); }
    catch (error) { console.error('Не удалось закрыть окно запуска', error); }
  });
  const listen = api?.event?.listen;
  if (listen) {
    void listen('service-status', event => { log(`service status stage=${event.payload?.stage}`); setStage(event.payload?.stage, event.payload?.message); });
    void listen('service-error', event => {
      const message = event.payload?.message || 'Сервис не ответил. Закройте приложение и попробуйте запустить его снова.';
      log(`service error: ${message}`);
      revealStatus();
      setStage(1, `RADAR & COMMS: ${message}`);
      if (bar) bar.setAttribute('aria-valuenow', '42');
    });
  }
})();
