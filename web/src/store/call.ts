import { create } from 'zustand';
import { Room, RoomEvent, Track } from 'livekit-client';
import { get, post, errorText } from '../lib/api';
import { realtime } from '../lib/realtime';
import type { RealtimePacket } from '../lib/types';
import { toast } from '../components/ui';
import {
  androidCallEnded,
  connectAndroidLiveKit,
  connectDesktopLiveKit,
  disconnectDesktopLiveKit,
  preferredCallTransport,
  setAndroidCallMuted,
  setDesktopCallMuted,
  type CallTransport,
} from '../lib/native';

export type CallPhase = 'idle' | 'outgoing' | 'incoming' | 'connecting' | 'active' | 'ended';

interface CallStore {
  phase: CallPhase;
  callId: string;
  peerId: number | null;
  peerName: string;
  muted: boolean;
  startedAt: number;
  reason: string;
  localLevel: number;
  remoteLevel: number;
  quality: 'good' | 'poor' | 'unknown';
  start(peerId: number, peerName: string): Promise<void>;
  accept(): Promise<void>;
  decline(): void;
  hangup(reason?: string): void;
  toggleMute(): void;
  handle(packet: RealtimePacket): void;
  init(): void;
}

interface LiveKitCredentials { url: string; token: string; room: string }
interface NativeCallEvent extends CustomEvent<{ type: string; message?: string }> {}

let room: Room | null = null;
let ring: { stop(): void } | null = null;
let noAnswerTimer = 0;
let pendingPoll = 0;
let initialized = false;
let nativeTransport: CallTransport = 'browser';
let credentials: LiveKitCredentials | null = null;
let intentionalDisconnect = false;
const signal = (peerId: number, payload: Record<string, unknown>) =>
  post('/api/calls/relay', { recipient_id: peerId, signal: payload });

export const useCall = create<CallStore>((set, getState) => ({
  phase: 'idle', callId: '', peerId: null, peerName: '', muted: false, startedAt: 0,
  reason: '', localLevel: 0, remoteLevel: 0, quality: 'unknown',

  init() {
    if (initialized) return;
    initialized = true;
    realtime.on(packet => getState().handle(packet));
    const restore = () => { void restorePendingCalls(getState().handle); };
    window.addEventListener('focus', restore);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') restore(); });
    window.addEventListener('rampulse-native-call', (event: Event) => {
      const detail = (event as NativeCallEvent).detail;
      if (detail?.type === 'ended' && !intentionalDisconnect) getState().hangup('Связь завершена');
      if (detail?.type === 'error') getState().hangup(detail.message || 'Ошибка нативного аудиосоединения');
    });
    window.addEventListener('beforeunload', () => {
      const { phase, peerId, callId } = getState();
      if (phase !== 'idle' && phase !== 'ended' && peerId) navigator.sendBeacon?.('/api/calls/relay', new Blob([JSON.stringify({ recipient_id: peerId, signal: { type: 'hangup', call_id: callId } })], { type: 'application/json' }));
    });
    restore();
  },

  async start(peerId, peerName) {
    if (getState().phase !== 'idle' && getState().phase !== 'ended') return;
    const callId = crypto.randomUUID?.() ?? 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
      const r = Math.random() * 16 | 0;
      return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
    nativeTransport = preferredCallTransport();
    if (nativeTransport === 'unsupported') {
      toast.bad('В этом APK не найден нативный аудиомодуль. Установите свежую Android-сборку RampPulse.', 'Звонки недоступны');
      return;
    }
    if (nativeTransport === 'browser' && (!window.RTCPeerConnection || !navigator.mediaDevices?.getUserMedia)) {
      toast.bad('В этом браузере нет WebRTC. Используйте приложение RampPulse с нативной голосовой связью.', 'Звонки недоступны');
      return;
    }
    set({ phase: 'outgoing', callId, peerId, peerName, muted: false, reason: '', startedAt: 0, quality: 'unknown' });
    try {
      credentials = await post<LiveKitCredentials>('/api/calls/livekit-token', { call_id: callId });
      await signal(peerId, { type: 'invite', call_id: callId, transport: 'livekit' });
      ring = tone('outgoing');
      noAnswerTimer = window.setTimeout(() => getState().hangup('Абонент не ответил'), 45000);
    } catch (error) {
      cleanup();
      set({ phase: 'ended', reason: errorText(error) });
      toast.bad(errorText(error), 'Звонок не начался');
      endLater(set);
    }
  },

  async accept() {
    const { peerId, callId } = getState();
    if (getState().phase !== 'incoming' || !peerId) return;
    ring?.stop(); ring = null;
    clearTimeout(noAnswerTimer);
    set({ phase: 'connecting' });
    try {
      nativeTransport = preferredCallTransport();
      if (nativeTransport === 'unsupported') throw new Error('В APK не найден нативный аудиомодуль. Установите свежую Android-сборку RampPulse.');
      credentials = await post<LiveKitCredentials>('/api/calls/livekit-token', { call_id: callId });
      await connectMedia(credentials);
      await signal(peerId, { type: 'answer', call_id: callId, transport: 'livekit' });
    } catch (error) {
      getState().hangup(errorText(error) || 'Не удалось подключиться к голосовой комнате');
      toast.bad(errorText(error), 'Не удалось ответить');
    }
  },

  decline() {
    const { peerId, callId } = getState();
    if (peerId) signal(peerId, { type: 'decline', call_id: callId }).catch(() => {});
    cleanup();
    set({ phase: 'ended', reason: 'Вызов отклонён' });
    endLater(set);
  },

  hangup(reason = 'Звонок завершён') {
    const { peerId, callId, phase } = getState();
    if (phase === 'idle') return;
    if (peerId && phase !== 'ended') signal(peerId, { type: 'hangup', call_id: callId }).catch(() => {});
    cleanup();
    set({ phase: 'ended', reason });
    endLater(set);
  },

  toggleMute() {
    const muted = !getState().muted;
    if (nativeTransport === 'android-native') setAndroidCallMuted(muted);
    else if (nativeTransport === 'tauri-native') void setDesktopCallMuted(muted).catch(error => toast.bad(errorText(error)));
    else if (nativeTransport === 'unsupported') toast.bad('Нативный аудиомодуль не установлен');
    else void room?.localParticipant.setMicrophoneEnabled(!muted).catch(() => toast.bad('Не удалось изменить микрофон'));
    set({ muted });
  },

  handle(packet) {
    if (!packet.kind.startsWith('call_')) return;
    const p = packet.payload || {};
    const kind: string = p.kind;
    const state = getState();
    const sameCall = p.call_id && p.call_id === state.callId;

    if (kind === 'ring') {
      if (state.phase !== 'idle' && state.phase !== 'ended') {
        signal(Number(p.from_user_id), { type: 'busy', call_id: p.call_id }).catch(() => {});
        return;
      }
      nativeTransport = preferredCallTransport();
      credentials = null;
      set({ phase: 'incoming', callId: String(p.call_id || ''), peerId: Number(p.from_user_id), peerName: String(p.from_name || 'Собеседник'), muted: false, reason: '', startedAt: 0, quality: 'unknown' });
      ring = tone('incoming');
      noAnswerTimer = window.setTimeout(() => { if (getState().phase === 'incoming') { cleanup(); set({ phase: 'ended', reason: 'Пропущенный вызов' }); endLater(set); } }, 45000);
      if (document.visibilityState !== 'visible' && 'Notification' in window && Notification.permission === 'granted') {
        try { new Notification('Входящий вызов', { body: String(p.from_name || 'RampPulse'), tag: 'call' }); } catch { /* native push handles background */ }
      }
      return;
    }
    if (!sameCall) return;
    if (kind === 'answer' && state.phase === 'outgoing') {
      ring?.stop(); ring = null;
      clearTimeout(noAnswerTimer);
      set({ phase: 'connecting' });
      if (!credentials) { getState().hangup('Истёк токен голосовой связи'); return; }
      void connectMedia(credentials).catch(error => getState().hangup(errorText(error)));
      return;
    }
    if (kind === 'decline' || kind === 'busy') {
      cleanup();
      set({ phase: 'ended', reason: kind === 'busy' ? 'Абонент занят' : 'Вызов отклонён' });
      endLater(set);
      return;
    }
    if (kind === 'hangup') {
      cleanup();
      set({ phase: 'ended', reason: state.phase === 'incoming' ? 'Пропущенный вызов' : 'Собеседник завершил звонок' });
      endLater(set);
    }
  },
}));

async function connectMedia(auth: LiveKitCredentials) {
  if (nativeTransport === 'android-native') {
    // Android starts the microphone foreground service only after RECORD_AUDIO
    // permission is granted, inside its native LiveKit bridge. Starting it here
    // first can crash Android 14+ with a foreground-service security exception.
    await connectAndroidLiveKit(auth.url, auth.token);
    markActive();
    return;
  }
  if (nativeTransport === 'tauri-native') {
    await connectDesktopLiveKit(auth.url, auth.token);
    markActive();
    return;
  }
  if (nativeTransport === 'unsupported') throw new Error('Нативный аудиомодуль не установлен. Обновите приложение RampPulse.');
  if (!window.RTCPeerConnection || !navigator.mediaDevices?.getUserMedia) {
    throw new Error('В этом браузере отключена поддержка WebRTC. Используйте RampPulse с нативной голосовой связью.');
  }
  const liveRoom = new Room({ adaptiveStream: false, dynacast: false });
  room = liveRoom;
  intentionalDisconnect = false;
  liveRoom.on(RoomEvent.TrackSubscribed, (track, _publication, participant) => {
    if (track.kind !== Track.Kind.Audio) return;
    const element = track.attach() as HTMLMediaElement;
    element.autoplay = true;
    element.setAttribute('playsinline', '');
    element.dataset.rampulseParticipant = participant.identity;
    element.style.display = 'none';
    document.body.appendChild(element);
    void element.play().catch(() => toast.info('Нажмите в окне, чтобы включить звук', 'Звук'));
  });
  liveRoom.on(RoomEvent.TrackUnsubscribed, track => track.detach().forEach(element => element.remove()));
  liveRoom.on(RoomEvent.Disconnected, () => {
    if (!intentionalDisconnect && useCall.getState().phase !== 'ended' && useCall.getState().phase !== 'idle') useCall.getState().hangup('Связь с голосовым сервером потеряна');
  });
  await liveRoom.connect(auth.url, auth.token, { autoSubscribe: true });
  const published = await liveRoom.localParticipant.setMicrophoneEnabled(true);
  if (!published) throw new Error('Не удалось включить микрофон');
  markActive();
}

function markActive() {
  const current = useCall.getState();
  if (current.phase === 'ended' || current.phase === 'idle') return;
  useCall.setState({ phase: 'active', startedAt: current.startedAt || Date.now(), quality: 'good' });
}

function cleanup() {
  intentionalDisconnect = true;
  if (nativeTransport === 'android-native') androidCallEnded();
  else if (nativeTransport === 'tauri-native') void disconnectDesktopLiveKit().catch(() => {});
  ring?.stop(); ring = null;
  clearTimeout(noAnswerTimer);
  if (room) {
    const current = room;
    room = null;
    current.removeAllListeners();
    current.disconnect();
  }
  credentials = null;
  useCall.setState({ localLevel: 0, remoteLevel: 0 });
}

async function restorePendingCalls(handle: (packet: RealtimePacket) => void) {
  if (pendingPoll || (useCall.getState().phase !== 'idle' && useCall.getState().phase !== 'ended')) return;
  pendingPoll = window.setTimeout(() => { pendingPoll = 0; }, 3000);
  try {
    const result = await get<{ invites?: Record<string, unknown>[] }>('/api/calls/pending');
    if (useCall.getState().phase !== 'idle' && useCall.getState().phase !== 'ended') return;
    const invite = result.invites?.[0];
    if (invite) handle({ protocol: 1, event_id: `push-${Date.now()}`, sequence: 0, occurred_at_ms: Date.now(), kind: 'call_invited', actor: null, entity: null, payload: invite } as RealtimePacket);
  } catch { /* offline; next focus or app resume retries */ }
}

function endLater(set: (p: Partial<CallStore>) => void) {
  setTimeout(() => { if (useCall.getState().phase === 'ended') set({ phase: 'idle', peerId: null, callId: '', peerName: '' }); }, 2200);
}

function tone(kind: 'incoming' | 'outgoing') {
  let stopped = false;
  let timer = 0;
  let context: AudioContext | null = null;
  try {
    context = new AudioContext();
    const ctx = context;
    const beep = () => {
      if (stopped) return;
      const t = ctx.currentTime;
      const freqs = kind === 'incoming' ? [660, 880] : [440];
      freqs.forEach((f, i) => {
        const oscillator = ctx.createOscillator(), gain = ctx.createGain();
        oscillator.type = 'sine'; oscillator.frequency.value = f;
        const at = t + i * 0.18;
        gain.gain.setValueAtTime(0.0001, at); gain.gain.exponentialRampToValueAtTime(kind === 'incoming' ? 0.14 : 0.07, at + 0.03);
        gain.gain.exponentialRampToValueAtTime(0.0001, at + (kind === 'incoming' ? 0.5 : 1));
        oscillator.connect(gain).connect(ctx.destination); oscillator.start(at); oscillator.stop(at + 1.1);
      });
      timer = window.setTimeout(beep, kind === 'incoming' ? 1600 : 3000);
    };
    beep();
  } catch { /* notification sound is optional */ }
  return { stop() { stopped = true; clearTimeout(timer); void context?.close().catch(() => {}); } };
}
