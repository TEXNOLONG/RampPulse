import { create } from 'zustand';
import { get, post } from '../lib/api';
import { realtime } from '../lib/realtime';
import type { Airport, Meta, RealtimePacket, ShiftState, User } from '../lib/types';

interface OpsStore {
  me: User | null;
  meta: Meta | null;
  airport: Airport | null;
  state: ShiftState | null;
  online: boolean;
  /** bumps on every positional update; the map subscribes to it instead of the whole state */
  tick: number;
  loading: boolean;
  error: string | null;
  boot(): Promise<void>;
  reload(): Promise<void>;
  setMe(user: User): void;
  handle(packet: RealtimePacket): void;
}

let reloadTimer = 0;

export const useOps = create<OpsStore>((set, getState) => ({
  me: null,
  meta: null,
  airport: null,
  state: null,
  online: false,
  tick: 0,
  loading: true,
  error: null,

  async boot() {
    try {
      const [{ user }, meta, airport, state] = await Promise.all([
        get<{ user: User }>('/api/auth/me'),
        get<Meta>('/api/meta'),
        get<Airport>('/api/airport'),
        get<ShiftState>('/api/state'),
      ]);
      set({ me: user, meta, airport, state, loading: false, error: null });
      realtime.onStatus(online => set({ online }));
      realtime.on(packet => getState().handle(packet));
      realtime.start();
    } catch (error) {
      set({ loading: false, error: error instanceof Error ? error.message : 'Не удалось загрузить смену' });
    }
  },

  async reload() {
    try {
      const state = await get<ShiftState>('/api/state');
      set(s => ({ state, me: state.account ?? s.me, tick: s.tick + 1 }));
    } catch { /* keep previous snapshot */ }
  },

  setMe(user) {
    set(s => ({ me: user, state: s.state ? { ...s.state, account: user } : s.state }));
  },

  handle(packet) {
    const kind = packet.kind;
    if (kind === 'heartbeat_ack' || kind.startsWith('chat_') || kind.startsWith('call_') || kind === 'presence_changed') return;
    const current = getState().state;
    if (kind === 'state_delta' && packet.entity?.kind === 'simulation' && current) {
      applySimulationDelta(current, packet.payload);
      set(s => ({ state: { ...current }, tick: s.tick + 1 }));
      return;
    }
    // Domain change: coalesce bursts of events into one snapshot fetch.
    clearTimeout(reloadTimer);
    reloadTimer = window.setTimeout(() => getState().reload(), kind === 'connection_ready' ? 0 : 120);
  },
}));

/** Mutates the snapshot in place with the 1 Hz simulation delta (positions, timers). */
function applySimulationDelta(state: ShiftState, payload: any) {
  const { aircraft: aircraftDeltas = [], techs: techDeltas = [], ...simulation } = payload || {};
  const previous = Number(state.sim_time || 0);
  Object.assign(state, simulation);
  const step = Math.max(0, Number(state.sim_time || 0) - previous);
  const techs = new Map(state.techs.map(t => [t.id, t]));
  const authoritativeEta = new Map<number, number>();
  for (const delta of techDeltas) {
    const tech = techs.get(Number(delta.id));
    if (tech) Object.assign(tech, delta);
    if (delta.request_id != null) authoritativeEta.set(Number(delta.request_id), delta.eta_left);
  }
  if (step > 0) {
    for (const r of state.active) {
      if (['waiting', 'enroute', 'assigned', 'arrived', 'working'].includes(r.status)) {
        r.elapsed = Number(r.elapsed || 0) + step;
        if (r.status === 'enroute' && r.eta_left != null && !authoritativeEta.has(r.id)) r.eta_left = Math.max(0, r.eta_left - step);
      }
      if (authoritativeEta.has(r.id)) r.eta_left = authoritativeEta.get(r.id)!;
    }
  }
  const aircraft = new Map(aircraftDeltas.map((a: any) => [Number(a.id), a]));
  for (const a of state.aircraft) {
    const d: any = aircraft.get(a.id);
    if (d) Object.assign(a, d);
  }
  if (state.me && techs.has(state.me.id)) Object.assign(state.me, techs.get(state.me.id));
}

export const act = {
  sim: (body: { speed?: number; running?: boolean }) => post('/api/sim', body),
  createRequest: (body: { stand: string; description: string; qual: string; extra: string; priority: string }) => post('/api/requests', body),
  dispatcherStep: (id: number, step: 'arrive' | 'start' | 'resolve' | 'cancel') => post(`/api/requests/${id}/${step}`),
  engineerStep: (id: number, step: 'arrive' | 'start' | 'resolve') => post(`/api/engineer/requests/${id}/${step}`),
  blockEdge: (id: string, blocked: boolean) => post(`/api/edges/${id}/block`, { blocked }),
  spawnAircraft: () => post('/api/aircraft/spawn'),
  depart: (id: number) => post(`/api/aircraft/${id}/depart`),
  approve: (id: number) => post(`/api/registrations/${id}/approve`),
  reject: (id: number) => post(`/api/registrations/${id}/reject`),
  moveTech: (id: number, x: number, y: number) => post(`/api/techs/${id}/position`, { x, y }),
  techProfile: (id: number, qual: string, types: string[]) => post(`/api/techs/${id}/profile`, { qual, types }),
  shiftStart: () => post('/api/engineer/shift/start'),
  shiftEnd: () => post('/api/engineer/shift/end'),
  reset: () => post('/api/reset'),
  routePreview: (from: string, to: string) => post('/api/routes/preview', { from, to, blocked_edges: [] }),
  logout: async () => { try { await post('/api/auth/logout'); } finally { realtime.stop(); location.replace('/login'); } },
};
