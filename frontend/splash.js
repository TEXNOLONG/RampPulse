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
  const flightVideo = document.querySelector('.flight-video');
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const syncMotionPreference = () => {
    if (!flightVideo) return;
    if (reducedMotion.matches) flightVideo.pause();
    else void flightVideo.play().catch(() => {});
  };
  syncMotionPreference();
  reducedMotion.addEventListener?.('change', syncMotionPreference);
  const close = document.getElementById('splashClose');
  if (close) close.addEventListener('click', async () => {
    try { await api?.window?.getCurrentWindow?.().close(); }
    catch (error) { console.error('Не удалось закрыть окно запуска', error); }
  });
  const listen = api?.event?.listen;
  if (listen) {
    void listen('service-status', event => setStage(event.payload?.stage, event.payload?.message));
    void listen('service-error', event => {
      const message = event.payload?.message || 'Сервис не ответил. Закройте приложение и попробуйте запустить его снова.';
      document.querySelector('.boot-screen.video-only')?.classList.add('show-status');
      setStage(1, `RADAR & COMMS: ${message}`);
      if (bar) bar.setAttribute('aria-valuenow', '42');
    });
  }
})();
