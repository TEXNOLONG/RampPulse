(() => {
  const button = document.querySelector('[data-close-app]');
  const getCurrentWindow = window.__TAURI__?.window?.getCurrentWindow;
  if (!button || typeof getCurrentWindow !== 'function') return;

  document.body.classList.add('tauri-app');
  button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      await getCurrentWindow().close();
    } catch (error) {
      button.disabled = false;
      console.error('Не удалось закрыть окно приложения', error);
    }
  });
})();
