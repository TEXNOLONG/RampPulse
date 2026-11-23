import { useEffect, useState } from 'react';

const animatedModes = new Set<'loading' | 'logout'>();

export function Logo({ size = 40 }: { size?: number }) {
  return (
    <span className="logo" style={{ width: size, height: size }}>
      <img src="/rampulse-logo.png" alt="" draggable={false} />
    </span>
  );
}

export function BootScreen({ mode = 'loading', onAnimationComplete }: { mode?: 'loading' | 'logout'; onAnimationComplete?: () => void }) {
  const [showAnimation, setShowAnimation] = useState(() => !animatedModes.has(mode));
  useEffect(() => { if (showAnimation) animatedModes.add(mode); }, [mode, showAnimation]);
  useEffect(() => {
    if (!showAnimation) return;
    const stop = window.setTimeout(() => setShowAnimation(false), 1800);
    return () => window.clearTimeout(stop);
  }, [showAnimation]);
  useEffect(() => { if (!showAnimation) onAnimationComplete?.(); }, [showAnimation, onAnimationComplete]);
  return (
    <div className={`boot boot-fullscreen${showAnimation ? '' : ' boot-static-only'}`}>
      {showAnimation && <video className="boot-animation" src="/ramppulse-splash.mp4" autoPlay muted playsInline aria-hidden="true" onEnded={() => setShowAnimation(false)} onError={() => setShowAnimation(false)} />}
      <div className="boot-static"><Logo size={160} /></div>
      <b>RampPulse</b>
      <span>{mode === 'logout' ? 'Signing out...' : 'Connecting to the shift...'}</span>
    </div>
  );
}
