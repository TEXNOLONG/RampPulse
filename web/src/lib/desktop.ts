/** Thin bridge to the Tauri shell (desktop/Android); no-ops in a plain browser. */
type Invoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;

const tauri = (window as any).__TAURI__ as { core?: { invoke?: Invoke } } | undefined;
const invoke: Invoke | undefined = tauri?.core?.invoke;

export const desktop = {
  available: Boolean(invoke),
  isAndroid: /Android/i.test(navigator.userAgent),
  markReady() {
    document.body.classList.toggle('tauri-app', Boolean(invoke));
  },
  async openSecondWindow() {
    if (!invoke) { window.open(location.origin + '/login', '_blank', 'noopener'); return; }
    await invoke('open_secondary_session');
  },
  async close() {
    const w = (window as any).__TAURI__?.window?.getCurrentWindow?.();
    if (w) { try { await w.close(); return; } catch { /* fall through */ } }
    window.close();
  },
};
