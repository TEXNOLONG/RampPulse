import { create } from 'zustand';

export interface Prefs {
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
  try { return { ...defaults, ...JSON.parse(localStorage.getItem(KEY) || '{}') }; } catch { return defaults; }
}

export const usePrefs = create<Prefs & { set(patch: Partial<Prefs>): void }>(set => ({
  ...load(),
  set: patch => set(s => {
    const next = { ...s, ...patch };
    try {
      const { set: _ignored, ...plain } = next as any;
      localStorage.setItem(KEY, JSON.stringify(plain));
    } catch { /* storage unavailable */ }
    return next;
  }),
}));

export const prefs = { get: () => usePrefs.getState() };
