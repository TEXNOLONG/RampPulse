/** Thin bridge to the Tauri shell (desktop/Android); no-ops in a plain browser. */
type Invoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;

const tauri = (window as any).__TAURI__ as { core?: { invoke?: Invoke } } | undefined;
const invoke: Invoke | undefined = tauri?.core?.invoke;
const CLIENT_AUTH_KEY = 'ramppulse.client-authenticated.v1';
const CLIENT_TOKEN_KEY = 'ramppulse.client-access-token.v1';

function clientAuthenticated() {
  try { return sessionStorage.getItem(CLIENT_AUTH_KEY) === '1'; }
  catch { return false; }
}

function setClientAuthenticated(value: boolean) {
  try {
    if (value) sessionStorage.setItem(CLIENT_AUTH_KEY, '1');
    else sessionStorage.removeItem(CLIENT_AUTH_KEY);
  } catch { /* the server session remains authoritative */ }
}

function clientAccessToken(): string {
  try { return sessionStorage.getItem(CLIENT_TOKEN_KEY) || ''; }
  catch { return ''; }
}

function setClientAccessToken(token: string) {
  try {
    if (token) sessionStorage.setItem(CLIENT_TOKEN_KEY, token);
    else sessionStorage.removeItem(CLIENT_TOKEN_KEY);
  } catch { /* cookie auth remains available as a fallback */ }
}

export const desktop = {
  available: Boolean(invoke),
  clientOnly: import.meta.env.VITE_RAMPULSE_CLIENT_ONLY === '1',
  clientAuthenticated,
  setClientAuthenticated,
  clientAccessToken,
  setClientAccessToken,
  isAndroid: /Android/i.test(navigator.userAgent),
  async log(message: string) {
    if (invoke) {
      try { await invoke('write_client_diagnostic', { message }); }
      catch (error) { console.error('RampPulse diagnostic write failed', error); }
    } else console.info('[RampPulse]', message);
  },
  async readDiagnostics(): Promise<string> {
    if (!invoke) return 'Native diagnostic log is available in the desktop app.';
    return String(await invoke('read_client_diagnostics'));
  },
  markReady() {
    document.body.classList.toggle('tauri-app', Boolean(invoke));
  },
  async openSecondWindow() {
    if (this.clientOnly) return;
    if (!invoke) throw new Error('Opening another session requires the installed RampPulse desktop app.');
    await invoke('open_secondary_session');
  },
  async close() {
    const w = (window as any).__TAURI__?.window?.getCurrentWindow?.();
    if (w) { try { await w.close(); return; } catch { /* fall through */ } }
    window.close();
  },
};
