import type { Point } from './types';

export function routeInstruction(position: Point, route: Point[]) {
  if (route.length < 2) return { text: 'Вы у места назначения', remaining: 0, turn: 'arrive' };
  let best = Infinity, segment = 0, projected = position;
  for (let i = 0; i < route.length - 1; i++) {
    const a = route[i], b = route[i + 1];
    const dx = b[0] - a[0], dy = b[1] - a[1], length2 = dx*dx + dy*dy;
    const t = length2 ? Math.max(0, Math.min(1, ((position[0]-a[0])*dx + (position[1]-a[1])*dy)/length2)) : 0;
    const point: Point = [a[0]+t*dx, a[1]+t*dy];
    const distance = Math.hypot(position[0]-point[0], position[1]-point[1]);
    if (distance < best) { best = distance; segment = i; projected = point; }
  }
  const points = [projected, ...route.slice(segment + 1)];
  let remaining = 0;
  for (let i=1;i<points.length;i++) remaining += Math.hypot(points[i][0]-points[i-1][0],points[i][1]-points[i-1][1]);
  if (remaining < 3) return { text: 'Вы у места назначения', remaining, turn: 'arrive' };
  let distance = 0;
  for (let i=1;i<points.length-1;i++) {
    const a=points[i-1], b=points[i], c=points[i+1];
    const dx=b[0]-a[0],dy=b[1]-a[1];
    distance += Math.hypot(dx,dy);
    if (Math.hypot(dx,dy)<0.1 || Math.hypot(c[0]-b[0],c[1]-b[1])<0.1) continue;
    const angle=Math.atan2(dx*(c[1]-b[1])-dy*(c[0]-b[0]),dx*(c[0]-b[0])+dy*(c[1]-b[1]));
    if (Math.abs(angle)>Math.PI/6) {
      const turn=Math.abs(angle)>2.6?'uturn':angle>0?'right':'left';
      return {text:`Через ${Math.round(distance)} м ${turn==='uturn'?'развернитесь':turn==='right'?'поверните направо':'поверните налево'}`,remaining,turn};
    }
  }
  return {text:`Двигайтесь прямо ${Math.round(remaining)} м до цели`,remaining,turn:'straight'};
}
