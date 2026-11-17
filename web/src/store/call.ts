import { create } from 'zustand';
import { get, post, errorText } from '../lib/api';
import { realtime } from '../lib/realtime';
import type { RealtimePacket } from '../lib/types';
import { prefs } from './prefs';
import { toast } from '../components/ui';

export type CallPhase = 'idle' | 'outgoing' | 'incoming' | 'connecting' | 'active' | 'ended';

interface CallStore {
  phase: CallPhase;
  callId: string;
  peerId: number | null;
  peerName: string;
  muted: boolean;
  startedAt: number;
  reason: string;
  /** 0..1 levels for the voice wave */
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

let pc: RTCPeerConnection | null = null;
let localStream: MediaStream | null = null;
let remoteAudio: HTMLAudioElement | null = null;
let pendingOffer: string | null = null;
let iceBuffer: RTCIceCandidateInit[] = [];
let ring: { stop(): void } | null = null;
let noAnswerTimer = 0;
let failTimer = 0;
let meterFrame = 0;
let audioCtx: AudioContext | null = null;
let iceConfig: RTCIceServer[] | null = null;
let initialized = false;

const signal = (peerId: number, payload: Record<string, unknown>) =>
  post('/api/calls/relay', { recipient_id: peerId, signal: payload });

export const useCall = create<CallStore>((set, getState) => ({
  phase: 'idle',
  callId: '',
  peerId: null,
  peerName: '',
  muted: false,
  startedAt: 0,
  reason: '',
  localLevel: 0,
  remoteLevel: 0,
  quality: 'unknown',

  init() {
    if (initialized) return;
    initialized = true;
    realtime.on(packet => getState().handle(packet));
    window.addEventListener('beforeunload', () => {
      const { phase, peerId, callId } = getState();
      if (phase !== 'idle' && phase !== 'ended' && peerId) navigator.sendBeacon?.('/api/calls/relay', new Blob([JSON.stringify({ recipient_id: peerId, signal: { type: 'hangup', call_id: callId } })], { type: 'application/json' }));
    });
  },

  async start(peerId, peerName) {
    if (getState().phase !== 'idle' && getState().phase !== 'ended') return;
    const callId = crypto.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
    set({ phase: 'outgoing', callId, peerId, peerName, muted: false, reason: '', startedAt: 0, quality: 'unknown' });
    try {
      localStream = await getMicrophone();
      pc = await createPeer(peerId, callId);
      localStream.getTracks().forEach(t => pc!.addTrack(t, localStream!));
      const offer = await pc.createOffer({ offerToReceiveAudio: true });
      await pc.setLocalDescription(offer);
      await signal(peerId, { type: 'invite', call_id: callId, sdp: offer.sdp });
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
    if (getState().phase !== 'incoming' || !peerId || !pendingOffer) return;
    ring?.stop(); ring = null;
    set({ phase: 'connecting' });
    try {
      localStream = await getMicrophone();
      pc = await createPeer(peerId, callId);
      localStream.getTracks().forEach(t => pc!.addTrack(t, localStream!));
      await pc.setRemoteDescription({ type: 'offer', sdp: pendingOffer });
      pendingOffer = null;
      await flushIce();
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      await signal(peerId, { type: 'answer', call_id: callId, sdp: answer.sdp });
    } catch (error) {
      toast.bad(errorText(error), 'Не удалось ответить');
      getState().hangup('Ошибка соединения');
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
    localStream?.getAudioTracks().forEach(t => { t.enabled = !muted; });
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
        signal(p.from_user_id, { type: 'busy', call_id: p.call_id }).catch(() => {});
        return;
      }
      pendingOffer = p.sdp || null;
      iceBuffer = [];
      set({ phase: 'incoming', callId: p.call_id, peerId: p.from_user_id, peerName: p.from_name || 'Собеседник', muted: false, reason: '', startedAt: 0, quality: 'unknown' });
      ring = tone('incoming');
      noAnswerTimer = window.setTimeout(() => { if (getState().phase === 'incoming') { cleanup(); set({ phase: 'ended', reason: 'Пропущенный вызов' }); endLater(set); } }, 45000);
      if (document.visibilityState !== 'visible' && 'Notification' in window && Notification.permission === 'granted') {
        try { new Notification('Входящий вызов', { body: p.from_name || 'RampPulse', tag: 'call' }); } catch { /* ignore */ }
      }
      return;
    }
    if (!sameCall) return;
    if (kind === 'answer' && p.sdp && pc && state.phase === 'outgoing') {
      ring?.stop(); ring = null;
      clearTimeout(noAnswerTimer);
      set({ phase: 'connecting' });
      pc.setRemoteDescription({ type: 'answer', sdp: p.sdp }).then(flushIce).catch(() => getState().hangup('Ошибка соединения'));
      return;
    }
    if (kind === 'ice' && p.candidate) {
      if (pc?.remoteDescription) pc.addIceCandidate(p.candidate).catch(() => {});
      else iceBuffer.push(p.candidate);
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

async function getMicrophone(): Promise<MediaStream> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error(window.isSecureContext ? 'Микрофон недоступен на этом устройстве' : 'Для микрофона нужно защищённое подключение (HTTPS)');
  }
  const p = prefs.get();
  const ideal: MediaTrackConstraints = {
    echoCancellation: true,
    noiseSuppression: p.noiseSuppression,
    autoGainControl: true,
    ...(p.micDeviceId ? { deviceId: { ideal: p.micDeviceId } } : {}),
  };
  try {
    return await navigator.mediaDevices.getUserMedia({ audio: ideal, video: false });
  } catch (error: any) {
    if (error?.name === 'NotAllowedError') throw new Error('Доступ к микрофону запрещён. Разрешите его в настройках системы');
    if (error?.name === 'NotFoundError') throw new Error('Микрофон не найден. Подключите устройство или выберите его в настройках');
    // OverconstrainedError / TypeError on picky WebKit builds: retry with the simplest request.
    return navigator.mediaDevices.getUserMedia({ audio: true });
  }
}

async function createPeer(peerId: number, callId: string) {
  if (!iceConfig) {
    try { iceConfig = (await get<{ ice_servers: RTCIceServer[] }>('/api/calls/config')).ice_servers; }
    catch { iceConfig = [{ urls: 'stun:stun.l.google.com:19302' }]; }
    setTimeout(() => { iceConfig = null; }, 10 * 60 * 1000); // TURN credentials are short-lived
  }
  const peer = new RTCPeerConnection({ iceServers: iceConfig });
  peer.onicecandidate = e => {
    if (e.candidate) signal(peerId, { type: 'ice', call_id: callId, candidate: e.candidate.toJSON() }).catch(() => {});
  };
  peer.ontrack = e => {
    remoteAudio ??= Object.assign(document.createElement('audio'), { autoplay: true });
    (remoteAudio as any).playsInline = true;
    remoteAudio.srcObject = e.streams[0] ?? new MediaStream([e.track]);
    const sink = prefs.get().speakerDeviceId;
    if (sink && (remoteAudio as any).setSinkId) (remoteAudio as any).setSinkId(sink).catch(() => {});
    remoteAudio.play().catch(() => toast.info('Нажмите в любом месте окна, чтобы включить звук', 'Звук'));
    startMeters(e.streams[0] ?? new MediaStream([e.track]));
  };
  peer.onconnectionstatechange = () => {
    const s = peer.connectionState;
    if (s === 'connected') {
      clearTimeout(failTimer);
      const st = useCall.getState();
      useCall.setState({ phase: 'active', startedAt: st.startedAt || Date.now(), quality: 'good' });
    } else if (s === 'disconnected') {
      useCall.setState({ quality: 'poor' });
      clearTimeout(failTimer);
      failTimer = window.setTimeout(() => peer.connectionState !== 'connected' && useCall.getState().hangup('Связь потеряна'), 12000);
    } else if (s === 'failed') {
      useCall.getState().hangup('Не удалось установить соединение. Проверьте сеть или TURN-сервер');
    }
  };
  return peer;
}

async function flushIce() {
  const buffered = iceBuffer; iceBuffer = [];
  for (const c of buffered) await pc?.addIceCandidate(c).catch(() => {});
}

function startMeters(remote: MediaStream) {
  try {
    audioCtx ??= new AudioContext();
    const make = (stream: MediaStream) => {
      const a = audioCtx!.createAnalyser(); a.fftSize = 256;
      audioCtx!.createMediaStreamSource(stream).connect(a);
      return a;
    };
    const ra = make(remote);
    const la = localStream ? make(localStream) : null;
    const buf = new Uint8Array(128);
    const level = (a: AnalyserNode) => { a.getByteTimeDomainData(buf); let peak = 0; for (const v of buf) peak = Math.max(peak, Math.abs(v - 128)); return Math.min(1, peak / 64); };
    let last = 0;
    const loop = (t: number) => {
      if (t - last > 70) {
        last = t;
        useCall.setState({ remoteLevel: level(ra), localLevel: la && !useCall.getState().muted ? level(la) : 0 });
      }
      meterFrame = requestAnimationFrame(loop);
    };
    meterFrame = requestAnimationFrame(loop);
  } catch { /* metering optional */ }
}

function cleanup() {
  ring?.stop(); ring = null;
  clearTimeout(noAnswerTimer); clearTimeout(failTimer);
  cancelAnimationFrame(meterFrame);
  pc?.getSenders().forEach(s => s.track?.stop());
  pc?.close(); pc = null;
  localStream?.getTracks().forEach(t => t.stop()); localStream = null;
  if (remoteAudio) { remoteAudio.srcObject = null; }
  pendingOffer = null; iceBuffer = [];
  useCall.setState({ localLevel: 0, remoteLevel: 0 });
}

function endLater(set: (p: Partial<CallStore>) => void) {
  setTimeout(() => { if (useCall.getState().phase === 'ended') set({ phase: 'idle', peerId: null, callId: '' }); }, 2200);
}

/** Generated ringtones (no audio files). */
function tone(kind: 'incoming' | 'outgoing') {
  let stopped = false;
  let timer = 0;
  try {
    audioCtx ??= new AudioContext();
    const ctx = audioCtx;
    const beep = () => {
      if (stopped) return;
      const t = ctx.currentTime;
      const freqs = kind === 'incoming' ? [660, 880] : [440];
      freqs.forEach((f, i) => {
        const o = ctx.createOscillator(), g = ctx.createGain();
        o.type = 'sine'; o.frequency.value = f;
        const at = t + i * 0.18;
        g.gain.setValueAtTime(0.0001, at); g.gain.exponentialRampToValueAtTime(kind === 'incoming' ? 0.18 : 0.08, at + 0.03);
        g.gain.exponentialRampToValueAtTime(0.0001, at + (kind === 'incoming' ? 0.5 : 1.0));
        o.connect(g).connect(ctx.destination); o.start(at); o.stop(at + 1.1);
      });
      timer = window.setTimeout(beep, kind === 'incoming' ? 1600 : 3000);
    };
    beep();
  } catch { /* autoplay policy */ }
  return { stop() { stopped = true; clearTimeout(timer); } };
}
