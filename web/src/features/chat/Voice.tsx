import { useEffect, useRef, useState } from 'react';
import { Play, Pause, Mic, Trash2, Send } from 'lucide-react';
import { cx, mmss } from '../../lib/format';
import { prefs } from '../../store/prefs';
import { toast } from '../../components/ui';

/** Deterministic pseudo-waveform from a seed (server does not store peaks). */
function bars(seed: string, n = 34) {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  return Array.from({ length: n }, (_, i) => {
    h = Math.imul(h ^ (i + 1), 16777619);
    const v = ((h >>> 0) % 1000) / 1000;
    return 0.25 + 0.75 * Math.abs(Math.sin(i * 0.55 + v * 3)) * (0.6 + 0.4 * v);
  });
}

const RATES = [1, 1.5, 2];

export function VoicePlayer({ src, duration, own, seed }: { src: string; duration: number | null; own?: boolean; seed: string }) {
  const audio = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [length, setLength] = useState(duration || 0);
  const [rate, setRate] = useState(1);
  const wave = useRef(bars(seed)).current;

  useEffect(() => () => { audio.current?.pause(); }, []);

  function toggle() {
    if (!audio.current) {
      const a = new Audio(src);
      a.preload = 'auto';
      a.onloadedmetadata = () => Number.isFinite(a.duration) && setLength(a.duration);
      a.ontimeupdate = () => setProgress(a.duration && Number.isFinite(a.duration) ? a.currentTime / a.duration : length ? a.currentTime / length : 0);
      a.onended = () => { setPlaying(false); setProgress(0); };
      a.onerror = () => { setPlaying(false); toast.bad('Формат не поддерживается этим устройством', 'Голосовое'); };
      const sink = prefs.get().speakerDeviceId;
      if (sink && (a as any).setSinkId) (a as any).setSinkId(sink).catch(() => {});
      audio.current = a;
    }
    const a = audio.current;
    a.playbackRate = rate;
    if (playing) { a.pause(); setPlaying(false); }
    else { document.dispatchEvent(new CustomEvent('rp-voice-play', { detail: a })); a.play().then(() => setPlaying(true)).catch(() => toast.bad('Не удалось воспроизвести')); }
  }

  useEffect(() => {
    const stopOthers = (e: Event) => { if ((e as CustomEvent).detail !== audio.current && playing) { audio.current?.pause(); setPlaying(false); } };
    document.addEventListener('rp-voice-play', stopOthers);
    return () => document.removeEventListener('rp-voice-play', stopOthers);
  }, [playing]);

  function seek(e: React.MouseEvent<HTMLDivElement>) {
    const r = e.currentTarget.getBoundingClientRect();
    const k = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    if (audio.current && Number.isFinite(audio.current.duration)) audio.current.currentTime = k * audio.current.duration;
    setProgress(k);
  }

  return (
    <div className={cx('voice', own && 'own')}>
      <button className="voice-play" onClick={toggle} aria-label={playing ? 'Пауза' : 'Слушать'}>{playing ? <Pause size={18} fill="currentColor" /> : <Play size={18} fill="currentColor" />}</button>
      <div className="voice-body">
        <div className="voice-wave" onClick={seek}>
          {wave.map((v, i) => <i key={i} className={cx(i / wave.length < progress && 'on')} style={{ height: `${v * 100}%` }} />)}
        </div>
        <div className="voice-meta">
          <span className="mono">{playing || progress ? mmss(progress * length) : mmss(length)}</span>
          <button onClick={() => { const r = RATES[(RATES.indexOf(rate) + 1) % RATES.length]; setRate(r); if (audio.current) audio.current.playbackRate = r; }}>{rate}×</button>
        </div>
      </div>
    </div>
  );
}

function pickMime() {
  const types = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4', 'audio/webm'];
  return types.find(t => (window as any).MediaRecorder?.isTypeSupported?.(t)) || '';
}

/** Telegram-like recorder: click to start, live level wave, cancel or send. */
export function VoiceRecorder({ onSend, onCancel }: { onSend(blob: Blob, seconds: number): void; onCancel(): void }) {
  const [seconds, setSeconds] = useState(0);
  const [levels, setLevels] = useState<number[]>(Array(28).fill(0.1));
  const rec = useRef<{ recorder: MediaRecorder; stream: MediaStream; chunks: Blob[]; started: number; ctx: AudioContext; raf: number; sendOnStop: boolean } | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        if (!navigator.mediaDevices?.getUserMedia) throw new Error(window.isSecureContext ? 'Микрофон недоступен' : 'Для записи нужен HTTPS');
        if (!(window as any).MediaRecorder) throw new Error('Запись звука не поддерживается этим устройством');
        const p = prefs.get();
        let stream: MediaStream;
        try { stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: p.noiseSuppression, ...(p.micDeviceId ? { deviceId: { ideal: p.micDeviceId } } : {}) } }); }
        catch (e: any) { if (e?.name === 'NotAllowedError') throw new Error('Доступ к микрофону запрещён'); stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
        if (cancelled) { stream.getTracks().forEach(t => t.stop()); return; }
        const mime = pickMime();
        const recorder = new MediaRecorder(stream, mime ? { mimeType: mime, audioBitsPerSecond: 48000 } : undefined);
        const ctx = new AudioContext();
        const an = ctx.createAnalyser(); an.fftSize = 256;
        ctx.createMediaStreamSource(stream).connect(an);
        const buf = new Uint8Array(128);
        const state = { recorder, stream, chunks: [] as Blob[], started: Date.now(), ctx, raf: 0, sendOnStop: false };
        rec.current = state;
        recorder.ondataavailable = e => e.data.size && state.chunks.push(e.data);
        recorder.onstop = () => {
          stream.getTracks().forEach(t => t.stop()); ctx.close().catch(() => {}); cancelAnimationFrame(state.raf);
          if (state.sendOnStop) {
            const blob = new Blob(state.chunks, { type: (recorder.mimeType || mime || 'audio/webm').split(';')[0] });
            const secs = (Date.now() - state.started) / 1000;
            if (secs < 0.6 || blob.size < 400) { toast.info('Слишком короткое сообщение'); onCancel(); return; }
            onSend(blob, secs);
          }
        };
        recorder.start(250);
        let last = 0;
        const loop = (t: number) => {
          if (t - last > 90) {
            last = t;
            an.getByteTimeDomainData(buf);
            let peak = 0; for (const v of buf) peak = Math.max(peak, Math.abs(v - 128));
            setLevels(l => [...l.slice(1), Math.max(0.08, Math.min(1, peak / 50))]);
            const s = (Date.now() - state.started) / 1000;
            setSeconds(s);
            if (s > 300) stop(true);
          }
          state.raf = requestAnimationFrame(loop);
        };
        state.raf = requestAnimationFrame(loop);
      } catch (e: any) {
        toast.bad(e?.message || 'Микрофон недоступен', 'Голосовое');
        onCancel();
      }
    })();
    return () => { cancelled = true; const r = rec.current; if (r && r.recorder.state !== 'inactive') { r.sendOnStop = false; r.recorder.stop(); } };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function stop(send: boolean) {
    const r = rec.current;
    if (!r) { onCancel(); return; }
    r.sendOnStop = send;
    if (r.recorder.state !== 'inactive') r.recorder.stop();
    if (!send) onCancel();
  }

  return (
    <div className="recorder">
      <button className="rec-cancel" onClick={() => stop(false)} aria-label="Удалить запись"><Trash2 size={18} /></button>
      <span className="rec-dot"><Mic size={14} /></span>
      <span className="rec-time mono">{mmss(seconds)}</span>
      <div className="rec-wave">{levels.map((v, i) => <i key={i} style={{ transform: `scaleY(${v})` }} />)}</div>
      <button className="send-btn" onClick={() => stop(true)} aria-label="Отправить голосовое"><Send size={18} /></button>
    </div>
  );
}
