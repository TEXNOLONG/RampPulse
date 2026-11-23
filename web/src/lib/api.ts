/** HTTP client for the RampPulse VPS. The configured URL is client preference data only. */
import { desktop } from './desktop';

const SERVER_URL_KEY = 'ramppulse.server-url.v1';
const REQUEST_TIMEOUT_MS = 20_000;

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export function getServerUrl(): string {
  try { return (localStorage.getItem(SERVER_URL_KEY) || '').trim().replace(/\/+$/, ''); }
  catch { return ''; }
}

export function normalizeServerUrl(value: string): string {
  let url: URL;
  try { url = new URL(value.trim()); }
  catch { throw new ApiError(0, 'Введите корректный адрес HTTPS API.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.origin === 'null') {
    throw new ApiError(0, 'Укажите HTTPS адрес API без логина, пароля, параметров и фрагмента.');
  }
  return url.toString().replace(/\/+$/, '');
}

export function saveServerUrl(value: string) {
  const normalized = normalizeServerUrl(value);
  localStorage.setItem(SERVER_URL_KEY, normalized);
  window.dispatchEvent(new Event('rampulse-server-changed'));
  return normalized;
}

export function clearServerUrl() {
  localStorage.removeItem(SERVER_URL_KEY);
  window.dispatchEvent(new Event('rampulse-server-changed'));
}

export function apiUrl(path: string): string {
  if (/^(?:https?:|blob:|data:)/i.test(path)) return path;
  const base = getServerUrl() || location.origin;
  return `${base}${path.startsWith('/') ? path : `/${path}`}`;
}

async function request(path: string, init: RequestInit = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  const headers = new Headers(init.headers);
  const accessToken = desktop.clientAccessToken();
  if (accessToken) headers.set('Authorization', `Bearer ${accessToken}`);
  try {
    return await fetch(apiUrl(path), { ...init, headers, credentials: 'include', signal: controller.signal });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw new ApiError(408, 'Сервер не ответил вовремя. Проверьте адрес и повторите попытку.');
    if (error instanceof TypeError) throw new ApiError(0, 'Сервер недоступен. Проверьте интернет, адрес API и сертификат HTTPS.');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function parse(response: Response) {
  const text = await response.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (!response.ok) {
    if (response.status === 401) {
      desktop.setClientAccessToken('');
      desktop.setClientAuthenticated(false);
      if (!location.pathname.startsWith('/login')) location.replace('/login');
    }
    const message = data?.detail || data?.error || (response.status >= 500 ? 'Сервер временно недоступен.' : `Ошибка ${response.status}`);
    throw new ApiError(response.status, message);
  }
  if (data === null) {
    throw new ApiError(502, 'VPS вернул пустой или не-JSON ответ. Проверьте адрес API и обновите сервер RampPulse.');
  }
  return data;
}

export async function probeServer(value: string): Promise<void> {
  const base = normalizeServerUrl(value);
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), 8_000);
  try {
    const response = await fetch(`${base}/healthz`, { method: 'GET', credentials: 'omit', headers: { Accept: 'application/json' }, signal: controller.signal });
    if (!response.ok) throw new ApiError(response.status, `Сервер ответил с ошибкой ${response.status}.`);
    const data = await response.json().catch(() => null);
    if (desktop.clientOnly) {
      const metaResponse = await fetch(`${base}/api/meta`, { method: 'GET', credentials: 'omit', headers: { Accept: 'application/json' }, signal: controller.signal });
      const meta = await metaResponse.json().catch(() => null);
      if (!metaResponse.ok || meta?.features?.native_client_token_auth !== true) {
        throw new ApiError(426, 'VPS API доступен, но версия сервера не поддерживает вход в Windows-приложение. Обновите VPS скриптом upgrade_vps_auth.ps1.');
      }
    }
    if (data?.ok !== true || data?.service !== 'ramppulse-rust') throw new ApiError(502, 'Адрес доступен, но это не API RampPulse.');
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (error instanceof DOMException && error.name === 'AbortError') throw new ApiError(408, 'Сервер не ответил за 8 секунд.');
    throw new ApiError(0, 'Сервер недоступен или не разрешил защищённое подключение. Проверьте URL, HTTPS и настройки CORS сервера.');
  } finally {
    clearTimeout(timer);
  }
}

export async function get<T = any>(path: string): Promise<T> {
  return parse(await request(path, { headers: { Accept: 'application/json' } }));
}

export async function post<T = any>(path: string, body: unknown = {}): Promise<T> {
  return parse(await request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  }));
}

export async function del<T = any>(path: string): Promise<T> {
  return parse(await request(path, { method: 'DELETE', headers: { Accept: 'application/json' } }));
}

export async function upload<T = any>(path: string, blob: Blob, headers: Record<string, string>): Promise<T> {
  return parse(await request(path, {
    method: 'POST',
    headers: { 'Content-Type': blob.type || 'application/octet-stream', ...headers },
    body: blob,
  }, 90_000));
}

export const errorText = (error: unknown) =>
  error instanceof Error ? error.message : typeof error === 'string' ? error : 'Неизвестная ошибка';
