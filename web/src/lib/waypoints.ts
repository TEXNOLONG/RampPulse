import type { Airport } from './types';

export function nearestWaypoint(airport: Airport, x: number, y: number, blocked: string[]) {
  const closed = new Set(blocked);
  const reachable = new Set(airport.edges.filter(edge => !edge.blocked && !closed.has(edge.id) && edge.kind !== 'runway'
    && (edge.walk_allowed !== false || edge.vehicle_allowed === true)).flatMap(edge => [edge.a, edge.b]));
  let nearest: Airport['nodes'][number] | null = null;
  let distance = 80;
  for (const node of airport.nodes) {
    if (!reachable.has(node.id)) continue;
    const d = Math.hypot(node.x-x,node.y-y);
    if (d < distance) { nearest=node; distance=d; }
  }
  return nearest;
}
