import { post } from './api';

declare global {
  interface Window {
    __TAURI__?: { core?: { invoke?: (command: string, args?: Record<string, unknown>) => Promise<any> } };
    RampPulseAndroid?: {
      getPushToken(): string;
      notificationsEnabled?(): boolean;
      requestNotifications(): void;
      startCall(): void;
      stopCall(): void;
      connectLiveKit(url: string, token: string): void;
      disconnectLiveKit(): void;
      setCallMuted(muted: boolean): void;
    };
  }
}

export type CallTransport = 'android-native' | 'tauri-native' | 'browser' | 'unsupported';

export function preferredCallTransport(): CallTransport {
  if (window.RampPulseAndroid?.connectLiveKit) return 'android-native';
  if (/Android/i.test(navigator.userAgent) && window.__TAURI__?.core?.invoke) return 'unsupported';
  if (window.__TAURI__?.core?.invoke) return 'tauri-native';
  return 'browser';
}

export async function connectDesktopLiveKit(url: string, token: string) {
  const invoke = window.__TAURI__?.core?.invoke;
  if (!invoke) throw new Error('Нативный аудиомодуль Linux не установлен. Обновите приложение RampPulse.');
  await invoke('native_call_connect', { url, token });
}

export async function disconnectDesktopLiveKit() {
  const invoke = window.__TAURI__?.core?.invoke;
  if (invoke) await invoke('native_call_disconnect');
}

export async function setDesktopCallMuted(muted: boolean) {
  const invoke = window.__TAURI__?.core?.invoke;
  if (!invoke) throw new Error('Нативный аудиомодуль Linux не установлен.');
  await invoke('native_call_set_muted', { muted });
}

let tokenTimer = 0;
let registering = false;

export function registerAndroidPush() {
  if (!/Android/i.test(navigator.userAgent) || !window.RampPulseAndroid) return;
  if (tokenTimer) window.clearInterval(tokenTimer);
  let attempts = 0;
  const register = async () => {
    if (registering) return;
    attempts += 1;
    let token = '';
    try { token = window.RampPulseAndroid?.getPushToken()?.trim() ?? ''; } catch { return; }
    if (!token) {
      if (attempts >= 120) window.clearInterval(tokenTimer);
      return;
    }
    if (localStorage.getItem('rampulse.push-token') === token) {
      return;
    }
    registering = true;
    try {
      await post('/api/push/register', { token });
      localStorage.setItem('rampulse.push-token', token);
      window.clearInterval(tokenTimer);
      tokenTimer = window.setInterval(register, 60_000);
    } catch {
      // Keep retrying while authenticated; network can be unavailable at launch.
    } finally { registering = false; }
  };
  void register();
  tokenTimer = window.setInterval(register, 1500);
}

export async function unregisterAndroidPush() {
  if (!/Android/i.test(navigator.userAgent) || !window.RampPulseAndroid) return;
  const token = localStorage.getItem('rampulse.push-token');
  if (!token) return;
  try { await post('/api/push/unregister', { token }); } finally { localStorage.removeItem('rampulse.push-token'); }
}

export function stopAndroidPushRegistration() {
  if (tokenTimer) window.clearInterval(tokenTimer);
  tokenTimer = 0;
}

export function androidCallStarted() {
  try { window.RampPulseAndroid?.startCall(); } catch { /* Android service is an optional keep-alive */ }
}

export function androidCallEnded() {
  try { window.RampPulseAndroid?.disconnectLiveKit(); window.RampPulseAndroid?.stopCall(); } catch { /* Android service is an optional keep-alive */ }
}

export function connectAndroidLiveKit(url: string, token: string): Promise<void> {
  const bridge = window.RampPulseAndroid;
  if (!bridge?.connectLiveKit) return Promise.reject(new Error('Нативный аудиомодуль Android не установлен'));
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => finish(new Error('Сервер звонков не ответил за 20 секунд')), 20_000);
    const finish = (error?: Error) => {
      clearTimeout(timer);
      window.removeEventListener('rampulse-native-call', onEvent);
      error ? reject(error) : resolve();
    };
    const onEvent = (event: Event) => {
      const detail = (event as CustomEvent<{ type: string; message?: string }>).detail;
      if (detail?.type === 'connected') finish();
      else if (detail?.type === 'error') finish(new Error(detail.message || 'Ошибка аудиосоединения'));
    };
    window.addEventListener('rampulse-native-call', onEvent);
    try { bridge.connectLiveKit(url, token); }
    catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
  });
}

export function setAndroidCallMuted(muted: boolean) {
  try { window.RampPulseAndroid?.setCallMuted(muted); } catch { /* native audio bridge is optional on desktop */ }
}
