import { create } from 'zustand';

export interface Prefs {
  theme: 'aviation' | 'amber' | 'teal';
  sound: boolean;
  desktopNotifications: boolean;
  reduceMotion: boolean;
  mapLabels: boolean;
  mapRoutes: boolean;
  density: 'comfortable' | 'compact';
  micDeviceId: string;
  speakerDeviceId: string;
  noiseSuppression: boolean;
}

const KEY = 'ramppulse.prefs.v1';
const defaults: Prefs = {
  theme: 'aviation',
  sound: true,
  desktopNotifications: false,
  reduceMotion: false,
  mapLabels: true,
  mapRoutes: true,
  density: 'comfortable',
  micDeviceId: '',
  speakerDeviceId: '',
  noiseSuppression: true,
};

function load(): Prefs {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || '{}');
    const theme = ['aviation', 'amber', 'teal'].includes(saved.theme) ? saved.theme : defaults.theme;
    return { ...defaults, ...saved, theme };
  } catch { return defaults; }
}

function applyTheme(theme: Prefs['theme']) {
  if (typeof document !== 'undefined') document.documentElement.dataset.theme = theme;
}

const initial = load();
applyTheme(initial.theme);

export const usePrefs = create<Prefs & { set(patch: Partial<Prefs>): void }>(set => ({
  ...initial,
  set: patch => set(s => {
    const next = { ...s, ...patch };
    applyTheme(next.theme);
    try {
      const { set: _ignored, ...plain } = next as any;
      localStorage.setItem(KEY, JSON.stringify(plain));
    } catch { /* storage unavailable */ }
    return next;
  }),
}));

export const prefs = { get: () => usePrefs.getState() };
