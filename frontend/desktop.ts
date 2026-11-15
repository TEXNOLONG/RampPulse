type AirportView = '2d' | '3d';

interface OtoDesktopPreferences {
  startupView: AirportView;
  ready: Promise<void>;
  getStartupView(): AirportView;
  setStartupView(view: AirportView): void;
  loadAirport(): Promise<Record<string, unknown> | null>;
}

interface TauriBridge {
  core?: { invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> };
}

interface Window {
  otoDesktop: OtoDesktopPreferences;
  __TAURI__?: TauriBridge;
}

const VIEW_KEY = 'oto-startup-view';
const validView = (value: string | null): value is AirportView => value === '2d' || value === '3d';
const invoke = window.__TAURI__?.core?.invoke?.bind(window.__TAURI__?.core);

window.otoDesktop = {
  startupView: '2d',
  ready: Promise.resolve(),
  getStartupView(): AirportView {
    return this.startupView;
  },
  setStartupView(view: AirportView): void {
    this.startupView = view;
    localStorage.setItem(VIEW_KEY, view);
    if (invoke) void invoke('set_startup_view', { startupView: view }).catch(() => {});
  },
  async loadAirport(): Promise<Record<string, unknown> | null> {
    if (!invoke) return null;
    try {
      return await invoke<Record<string, unknown>>('load_airport_data');
    } catch (error) {
      console.error('Rust не смог загрузить локальную карту; переключаюсь на API сервиса', error);
      return null;
    }
  },
};

window.otoDesktop.ready = (async () => {
  const fallback = localStorage.getItem(VIEW_KEY);
  window.otoDesktop.startupView = validView(fallback) ? fallback : '2d';
  if (!invoke) return;
  try {
    const preferences = await invoke<{ startupView?: string }>('get_preferences');
    if (preferences.startupView === '2d' || preferences.startupView === '3d') {
      window.otoDesktop.startupView = preferences.startupView;
    }
  } catch (_) {
    // Browser preview and older installs retain the local preference.
  }
})();
