export function Logo({ size = 40 }: { size?: number }) {
  return (
    <span className="logo" style={{ width: size, height: size }}>
      <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="1.7" /><path d="M12 12 18 6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /><circle cx="12" cy="12" r="1.7" fill="currentColor" /></svg>
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
