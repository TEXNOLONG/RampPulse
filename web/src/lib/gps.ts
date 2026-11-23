import { create } from 'zustand';

export type GpsStatus = 'IDLE' | 'REQUESTING_PERMISSION' | 'ACTIVE' | 'LOW_ACCURACY' | 'STALE' | 'ERROR' | 'STOPPED';
export interface GpsFix {
  latitude: number; longitude: number; accuracy: number; altitude: number | null;
  altitudeAccuracy: number | null; heading: number | null; speed: number | null; timestamp: number;
}
interface GpsStore {
  status: GpsStatus; raw: GpsFix | null; filtered: Pick<GpsFix, 'latitude' | 'longitude'> | null;
  error: string | null; jumpDetected: boolean; follow: boolean;
  start(): void; stop(): void; setFollow(value: boolean): void;
}
let watchId: number | null = null;
let staleTimer = 0;
let previousRaw: GpsFix | null = null;

function distanceMeters(a: GpsFix, b: GpsFix) {
  const radians = (degrees: number) => degrees * Math.PI / 180;
  const dLat = radians(b.latitude - a.latitude);
  const dLon = radians(b.longitude - a.longitude);
  const lat1 = radians(a.latitude), lat2 = radians(b.latitude);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 6_371_000 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

export const useGps = create<GpsStore>((set, get) => ({
  status: 'IDLE', raw: null, filtered: null, error: null, jumpDetected: false, follow: false,
  start() {
    if (watchId != null) return;
    previousRaw = null;
    window.clearTimeout(staleTimer);
    if (!('geolocation' in navigator)) {
      set({ status: 'ERROR', error: 'Это устройство не предоставляет Geolocation API.' });
      return;
    }
    set({ status: 'REQUESTING_PERMISSION', raw: null, filtered: null, error: null, jumpDetected: false, follow: false });
    watchId = navigator.geolocation.watchPosition(position => {
      const c = position.coords;
      const raw: GpsFix = {
        latitude: c.latitude, longitude: c.longitude, accuracy: c.accuracy,
        altitude: c.altitude, altitudeAccuracy: c.altitudeAccuracy,
        heading: c.heading, speed: c.speed, timestamp: position.timestamp,
      };
      const previous = previousRaw;
      const elapsed = previous ? Math.max(0.25, (raw.timestamp - previous.timestamp) / 1000) : 0;
      const jumpDetected = Boolean(previous && distanceMeters(previous, raw) / elapsed > 100);
      const priorFiltered = get().filtered;
      let filtered = priorFiltered;
      if (!jumpDetected || !priorFiltered) {
        if (!priorFiltered) filtered = { latitude: raw.latitude, longitude: raw.longitude };
        else {
          const previousAccuracy = Math.max(1, get().raw?.accuracy ?? raw.accuracy);
          const currentAccuracy = Math.max(1, raw.accuracy);
          const alpha = Math.max(0.2, Math.min(0.8, previousAccuracy / (previousAccuracy + currentAccuracy)));
          filtered = {
            latitude: priorFiltered.latitude + (raw.latitude - priorFiltered.latitude) * alpha,
            longitude: priorFiltered.longitude + (raw.longitude - priorFiltered.longitude) * alpha,
          };
        }
      }
      previousRaw = raw;
      set({ raw, filtered, jumpDetected, error: null, status: raw.accuracy > 25 ? 'LOW_ACCURACY' : 'ACTIVE' });
      window.clearTimeout(staleTimer);
      staleTimer = window.setTimeout(() => set(s => s.raw?.timestamp === raw.timestamp ? { status: 'STALE' } : s), 30_000);
    }, error => {
      watchId = null;
      window.clearTimeout(staleTimer);
      const message = error.code === error.PERMISSION_DENIED
        ? 'Разрешите RampPulse доступ к геолокации в настройках устройства.'
        : error.code === error.POSITION_UNAVAILABLE
          ? 'Устройство не отдаёт GPS. Включите системную геолокацию и выйдите на открытое место.'
          : 'GPS-фикс не получен вовремя. Проверьте системную геолокацию и попробуйте ещё раз.';
      set({ status: 'ERROR', error: message });
    }, { enableHighAccuracy: true, maximumAge: 0, timeout: 45_000 });
  },
  stop() {
    if (watchId != null) navigator.geolocation?.clearWatch(watchId);
    watchId = null; previousRaw = null; window.clearTimeout(staleTimer);
    set({ status: 'STOPPED', raw: null, filtered: null, error: null, jumpDetected: false, follow: false });
  },
  setFollow(value) { set({ follow: value }); },
}));
