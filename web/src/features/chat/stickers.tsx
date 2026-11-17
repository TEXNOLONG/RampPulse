import { type LucideIcon, CheckCircle2, Truck, Clock, PlaneTakeoff, LifeBuoy, Wrench, Cog, Zap, ClipboardCheck, Radio, Fuel, Anchor, TriangleAlert, Cross, BadgeCheck, MapPin } from 'lucide-react';

export const STICKERS: { key: string; label: string; icon: LucideIcon; color: string }[] = [
  { key: 'accepted', label: 'Принято', icon: CheckCircle2, color: '#10B981' },
  { key: 'enroute', label: 'Выезжаю', icon: Truck, color: '#818CF8' },
  { key: 'delay', label: 'Задержка', icon: Clock, color: '#F59E0B' },
  { key: 'ready', label: 'Борт готов', icon: PlaneTakeoff, color: '#22D3EE' },
  { key: 'help', label: 'Нужна помощь', icon: LifeBuoy, color: '#EF4444' },
  { key: 'tools', label: 'Нужен инструмент', icon: Wrench, color: '#A78BFA' },
  { key: 'engine', label: 'Двигатель', icon: Cog, color: '#F59E0B' },
  { key: 'power', label: 'Питание', icon: Zap, color: '#FACC15' },
  { key: 'check', label: 'Осмотр', icon: ClipboardCheck, color: '#22D3EE' },
  { key: 'radio', label: 'На связи', icon: Radio, color: '#818CF8' },
  { key: 'fuel', label: 'Топливо', icon: Fuel, color: '#F97316' },
  { key: 'tow', label: 'Буксировка', icon: Anchor, color: '#94A3B8' },
  { key: 'warning', label: 'Внимание', icon: TriangleAlert, color: '#EF4444' },
  { key: 'medical', label: 'Медпомощь', icon: Cross, color: '#F43F5E' },
  { key: 'done', label: 'Выполнено', icon: BadgeCheck, color: '#10B981' },
  { key: 'stand', label: 'На стоянке', icon: MapPin, color: '#6366F1' },
];

export function Sticker({ id, size = 64 }: { id: string; size?: number }) {
  const s = STICKERS.find(x => x.key === id);
  if (!s) return <span className="sticker unknown">{id}</span>;
  const Icon = s.icon;
  return (
    <span className="sticker" style={{ '--c': s.color } as React.CSSProperties}>
      <span className="sticker-art" style={{ width: size, height: size }}><Icon size={size * 0.5} strokeWidth={1.8} /></span>
      <b>{s.label}</b>
    </span>
  );
}
