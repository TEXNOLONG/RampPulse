import type { RealtimePacket } from './types';

type Listener = (packet: RealtimePacket) => void;
type StatusListener = (online: boolean) => void;

/**
 * Single shared WebSocket with heartbeat and exponential reconnect.
 * Domain mutations go over HTTP; this channel only carries server events.
 */
class Realtime {
  private ws: WebSocket | null = null;
  private listeners = new Set<Listener>();
  private statusListeners = new Set<StatusListener>();
  private retry = 0;
  private heartbeat = 0;
  private stopped = true;
  online = false;

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.open();
    document.addEventListener('visibilitychange', this.onVisible);
    window.addEventListener('online', this.onVisible);
  }

  stop() {
    this.stopped = true;
    clearInterval(this.heartbeat);
    this.ws?.close();
    this.ws = null;
    document.removeEventListener('visibilitychange', this.onVisible);
    window.removeEventListener('online', this.onVisible);
  }

  on(listener: Listener) {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  onStatus(listener: StatusListener) {
    this.statusListeners.add(listener);
    listener(this.online);
    return () => { this.statusListeners.delete(listener); };
  }

  private onVisible = () => {
    if (document.visibilityState === 'visible' && !this.online && !this.stopped) {
      this.retry = 0;
      this.ws?.close();
      this.open();
    }
  };

  private setOnline(value: boolean) {
    if (this.online === value) return;
    this.online = value;
    this.statusListeners.forEach(l => l(value));
  }

  private open() {
    const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${scheme}://${location.host}/ws`);
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      this.setOnline(true);
      clearInterval(this.heartbeat);
      this.heartbeat = window.setInterval(() => ws.readyState === 1 && ws.send('heartbeat'), 20000);
    };
    ws.onmessage = event => {
      try {
        const packet = JSON.parse(event.data) as RealtimePacket;
        if (packet?.kind) this.listeners.forEach(l => l(packet));
      } catch { /* ignore malformed frame */ }
    };
    ws.onclose = event => {
      if (this.ws !== ws) return;
      clearInterval(this.heartbeat);
      this.setOnline(false);
      if (event.code === 4401) { location.replace('/login'); return; }
      if (this.stopped) return;
      const delay = Math.min(10000, 500 * 2 ** this.retry++);
      setTimeout(() => !this.stopped && this.ws === ws && this.open(), delay);
    };
    ws.onerror = () => ws.close();
  }
}

export const realtime = new Realtime();
