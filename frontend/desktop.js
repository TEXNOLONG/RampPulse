"use strict";
var _a, _b, _c, _d;
const VIEW_KEY = 'oto-startup-view';
const validView = (value) => value === '2d' || value === '3d';
const invoke = (_c = (_b = (_a = window.__TAURI__) === null || _a === void 0 ? void 0 : _a.core) === null || _b === void 0 ? void 0 : _b.invoke) === null || _c === void 0 ? void 0 : _c.bind((_d = window.__TAURI__) === null || _d === void 0 ? void 0 : _d.core);
window.otoDesktop = {
    startupView: '2d',
    ready: Promise.resolve(),
    getStartupView() {
        return this.startupView;
    },
    setStartupView(view) {
        this.startupView = view;
        localStorage.setItem(VIEW_KEY, view);
        if (invoke)
            void invoke('set_startup_view', { startupView: view }).catch(() => { });
    },
    async loadAirport() {
        if (!invoke)
            return null;
        try {
            return await invoke('load_airport_data');
        }
        catch (error) {
            console.error('Rust не смог загрузить локальную карту; переключаюсь на API сервиса', error);
            return null;
        }
    },
};
window.otoDesktop.ready = (async () => {
    const fallback = localStorage.getItem(VIEW_KEY);
    window.otoDesktop.startupView = validView(fallback) ? fallback : '2d';
    if (!invoke)
        return;
    try {
        const preferences = await invoke('get_preferences');
        if (preferences.startupView === '2d' || preferences.startupView === '3d') {
            window.otoDesktop.startupView = preferences.startupView;
        }
    }
    catch (_) {
    }
})();
