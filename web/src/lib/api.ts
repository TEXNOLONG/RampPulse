/** HTTP client for the RampPulse Rust server (same origin, cookie session). */

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function parse(response: Response) {
  const text = await response.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (!response.ok) {
    if (response.status === 401 && !location.pathname.startsWith('/login')) {
      location.replace('/login');
    }
    const message = data?.detail || data?.error || (response.status >= 500 ? 'Сервер временно недоступен' : `Ошибка ${response.status}`);
    throw new ApiError(response.status, message);
  }
  return data;
}

export async function get<T = any>(path: string): Promise<T> {
  return parse(await fetch(path, { credentials: 'same-origin', headers: { Accept: 'application/json' } }));
}

export async function post<T = any>(path: string, body: unknown = {}): Promise<T> {
  return parse(await fetch(path, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  }));
}

export async function upload<T = any>(path: string, blob: Blob, headers: Record<string, string>): Promise<T> {
  return parse(await fetch(path, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': blob.type || 'application/octet-stream', ...headers },
    body: blob,
  }));
}

export const errorText = (error: unknown) =>
  error instanceof Error ? error.message : typeof error === 'string' ? error : 'Неизвестная ошибка';
