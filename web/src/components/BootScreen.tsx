export function Logo({ size = 40 }: { size?: number }) {
  return (
    <span className="logo" style={{ width: size, height: size }}>
      <img src="/rampulse-logo.png" alt="" draggable={false} />
    </span>
  );
}

export function BootScreen() {
  return (
    <div className="boot">
      <div className="boot-radar" aria-hidden><span /><i /></div>
      <b>RampPulse</b>
      <span>Подключаемся к смене…</span>
    </div>
  );
}
