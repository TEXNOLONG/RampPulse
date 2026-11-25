import type { Airport, Point, ShiftState } from '../../lib/types';
import { qualColor } from '../../lib/format';

const NS = 'http://www.w3.org/2000/svg';
const NORM = 900;
const PLANE = 'M0,-17 C1.4,-17 2.1,-14 2.1,-11 L2.1,-4 L15,3 L15,5.5 L2.1,2 L1.6,10 L5.5,13 L5.5,15 L0,13.6 L-5.5,15 L-5.5,13 L-1.6,10 L-2.1,2 L-15,5.5 L-15,3 L-2.1,-4 L-2.1,-11 C-2.1,-14 -1.4,-17 0,-17 Z';

export interface Selection { request: number | null; tech: number | null; aircraft: number | null; stand: string | null }
export interface Comparison { requestId: number; human: Point[]; system: Point[]; humanName: string; humanEta: number; systemEta: number }
export interface MapCallbacks {
  onPoint?(x: number, y: number): void;
  onStand?(id: string): void;
  onTech?(id: number): void;
  onAircraft?(id: number): void;
  onEdge?(id: string, name?: string): void;
  onEmpty?(): void;
  onView?(scaleMetersPerPx: number): void;
}
export interface MapOptions { pointSelection?: boolean; interactiveEdges: boolean; edgeMode?: boolean; showLabels: boolean; showRoutes: boolean; reduceMotion: boolean; focusTech?: number | null }

interface Motion { node: SVGGElement; x: number; y: number; a: number; tx: number; ty: number; ta: number; vx: number; vy: number; va: number }
interface Segment { id: string; name?: string; ax: number; ay: number; bx: number; by: number }

function el<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}, parent?: Element) {
  const node = document.createElementNS(NS, tag);
  for (const k in attrs) node.setAttribute(k, String(attrs[k]));
  parent?.appendChild(node);
  return node;
}
const pts = (p: Point[]) => p.map(q => `${q[0]},${q[1]}`).join(' ');

export class MapEngine {
  svg: SVGSVGElement;
  private air: Airport;
  private cb: MapCallbacks;
  private opts: MapOptions;
  private vb = { x: 0, y: 0, w: 1, h: 1 };
  private bounds: DOMRect;
  private layers!: Record<string, SVGGElement>;
  private segments: Segment[] = [];
  private nodes = new Map<string, { x: number; y: number }>();
  private stands = new Map<string, SVGGElement>();
  private techs = new Map<number, SVGGElement>();
  private aircraft = new Map<number, SVGGElement>();
  private motion = new Map<string, Motion>();
  private frame = 0;
  private flyFrame = 0;
  private sigs: Record<string, string> = {};
  private resize: ResizeObserver;
  private destroyed = false;

  constructor(svg: SVGSVGElement, air: Airport, cb: MapCallbacks, opts: MapOptions) {
    this.svg = svg; this.air = air; this.cb = cb; this.opts = opts;
    this.bounds = svg.getBoundingClientRect();
    air.nodes.forEach(n => this.nodes.set(n.id, n));
    this.build();
    this.fitStands(false);
    this.bindEvents();
    this.resize = new ResizeObserver(() => { this.bounds = svg.getBoundingClientRect(); this.apply(); });
    this.resize.observe(svg);
  }

  destroy() {
    this.destroyed = true;
    cancelAnimationFrame(this.frame); cancelAnimationFrame(this.flyFrame);
    this.resize.disconnect();
    this.svg.replaceChildren();
  }

  setWaypoints(ids: string[]) {
    const layer = this.layers.waypoints;
    layer.replaceChildren();
    ids.forEach((id, index) => {
      const point = this.nodes.get(id);
      if (!point) return;
      const marker = el('g', {transform:`translate(${point.x} ${point.y})`,class:'route-waypoint','pointer-events':'none'},layer);
      const symbol = el('g', {style:'transform:scale(var(--mk,1))'}, marker);
      el('circle',{r:13,fill:'var(--text)',stroke:'var(--bg)','stroke-width':2},symbol);
      el('text',{'text-anchor':'middle','dominant-baseline':'central',fill:'var(--bg)','font-size':14,'font-weight':700},symbol).textContent=String(index+1);
    });
  }

  setOptions(opts: Partial<MapOptions>) {
    this.opts = { ...this.opts, ...opts };
    this.svg.classList.toggle('no-labels', !this.opts.showLabels);
    this.svg.classList.toggle('no-routes', !this.opts.showRoutes);
    this.svg.classList.toggle('edge-mode', !!this.opts.edgeMode);
  }

  /* ---------------------------------------------------------------- static layers */
  private build() {
    const svg = this.svg;
    svg.replaceChildren();
    const L = (id: string) => el('g', { class: `layer-${id}` }, svg);
    this.layers = {
      areas: L('areas'), parking: L('parking'), runways: L('runways'), taxi: L('taxi'), blocked: L('blocked'),
      iso: L('iso'), alt: L('alt'), routes: L('routes'), compare: L('compare'), bases: L('bases'), stands: L('stands'),
      aircraft: L('aircraft'), techs: L('techs'), labels: L('labels'), tags: L('tags'), waypoints: L('waypoints'),
    };
    const { areas, parking, runways, taxi, bases, stands, labels } = this.layers;
    for (const a of this.air.areas || []) {
      el('polygon', { points: pts(a.points), class: `area area-${a.kind}` }, areas);
      if (a.name && a.kind === 'terminal' && a.points.length) {
        const cx = a.points.reduce((s, q) => s + q[0], 0) / a.points.length;
        const cy = a.points.reduce((s, q) => s + q[1], 0) / a.points.length;
        el('text', { class: 'area-label', x: cx, y: cy }, labels).textContent = a.name;
      }
    }
    const parkD = (this.air.parking || []).map(p => 'M' + p.points.map(q => `${q[0]} ${q[1]}`).join('L') + 'Z').join('');
    if (parkD) el('path', { d: parkD, class: 'parking' }, parking);
    for (const r of this.air.runways || []) {
      el('polyline', { points: pts(r.points), class: 'rwy', 'stroke-width': r.width || 45 }, runways);
      el('polyline', { points: pts(r.points), class: 'rwy-mark' }, runways);
      if (r.name && r.points.length) {
        const c = r.points[Math.floor(r.points.length / 2)];
        el('text', { class: 'rwy-label', x: c[0], y: c[1] - 42 }, labels).textContent = `ВПП ${r.name}`;
      }
    }
    let d = '';
    for (const e of this.air.edges) {
      const a = this.nodes.get(e.a), b = this.nodes.get(e.b);
      if (!a || !b) continue;
      d += `M${a.x} ${a.y}L${b.x} ${b.y}`;
      this.segments.push({ id: e.id, name: e.name, ax: a.x, ay: a.y, bx: b.x, by: b.y });
    }
    el('path', { d, class: 'taxi-base' }, taxi);
    el('path', { d, class: 'taxi-glow' }, taxi);
    for (const b of this.air.bases) {
      const n = this.nodes.get(b.node); if (!n) continue;
      const g = el('g', { class: 'base', transform: `translate(${n.x} ${n.y})` }, bases);
      const m = el('g', { class: 'mk' }, g);
      el('rect', { class: 'base-dot', x: -7, y: -7, width: 14, height: 14, rx: 4 }, m);
      el('rect', { class: 'base-core', x: -2.5, y: -2.5, width: 5, height: 5, rx: 1.5 }, m);
      el('text', { class: 'base-label', y: 22 }, m).textContent = b.name;
    }
    for (const s of this.air.stands) {
      const n = this.nodes.get(s.node); if (!n) continue;
      const g = el('g', { class: 'stand', 'data-stand': s.id, transform: `translate(${n.x} ${n.y})` }, stands);
      const m = el('g', { class: 'mk' }, g);
      el('rect', { class: 'slot', x: -15, y: -15, width: 30, height: 30, rx: 9 }, m);
      el('text', { class: 'stand-label', y: 29 }, m).textContent = s.id.replace(/^ВС-/, '');
      el('title', {}, g).textContent = `Стоянка ${s.id}`;
      this.stands.set(s.id, g);
    }
  }

  /* ---------------------------------------------------------------- dynamic update */
  update(state: ShiftState, sel: Selection, comparison: Comparison | null) {
    if (this.destroyed) return;
    this.updateAircraft(state, sel);
    this.updateTechs(state, sel);
    this.updateStands(state, sel);
    this.updateRoutes(state, sel);
    this.updateBlocked(state);
    this.updateIsochrone(state, sel);
    this.updateComparison(state, sel, comparison);
  }

  private updateAircraft(state: ShiftState, sel: Selection) {
    const seen = new Set<number>();
    for (const a of state.aircraft) {
      seen.add(a.id);
      let g = this.aircraft.get(a.id);
      if (!g) {
        g = el('g', { 'data-aircraft': a.id }, this.layers.aircraft);
        const m = el('g', { class: 'mk' }, g);
        el('path', { class: 'plane', d: PLANE }, m);
        el('title', {}, g);
        this.aircraft.set(a.id, g);
      }
      g.setAttribute('class', `aircraft ${a.status}${sel.aircraft === a.id ? ' sel' : ''}`);
      g.querySelector('title')!.textContent = `${a.flight} · ${a.model} · ${a.status_ru}${a.stand ? ` · ${a.stand}` : ''}`;
      this.moveTo(`ac:${a.id}`, g, a.x, a.y, a.heading || 0);
    }
    for (const [id, g] of this.aircraft) if (!seen.has(id)) { g.remove(); this.aircraft.delete(id); this.motion.delete(`ac:${id}`); }
  }

  private updateTechs(state: ShiftState, sel: Selection) {
    const req = sel.request != null ? state.active.find(r => r.id === sel.request) : null;
    const inZone = new Set((req?.candidates || []).filter(c => c.eta != null && c.eta <= NORM).map(c => c.tech_id));
    const seen = new Set<number>();
    for (const t of state.techs) {
      seen.add(t.id);
      let g = this.techs.get(t.id);
      if (!g) {
        g = el('g', { 'data-tech': t.id }, this.layers.techs);
        const m = el('g', { class: 'mk' }, g);
        el('circle', { class: 'tech-pulse', r: 15 }, m);
        el('circle', { class: 'tech-body', r: 11 }, m);
        el('text', { class: 'tech-num', y: 3.6 }, m).textContent = String(t.id);
        el('circle', { class: 'tech-state', cx: 8.5, cy: -8.5, r: 3.6 }, m);
        el('title', {}, g);
        this.techs.set(t.id, g);
      }
      (g as SVGGElement).style.setProperty('--q', qualColor(t.qual));
      const focus = this.opts.focusTech === t.id;
      g.setAttribute('class', [
        'tech', t.status, !t.on_shift && 'off', t.vehicle_id && 'in-vehicle', sel.tech === t.id && 'sel', focus && 'me',
        req && (inZone.has(t.id) ? 'in-zone' : t.id !== req.tech_id && 'out-zone'),
      ].filter(Boolean).join(' '));
      g.querySelector('title')!.textContent = `${t.name} · ${t.qual} · ${t.status === 'free' ? 'свободен' : 'на заявке'}`;
      this.moveTo(`t:${t.id}`, g, t.x, t.y, 0);
    }
    for (const [id, g] of this.techs) if (!seen.has(id)) { g.remove(); this.techs.delete(id); this.motion.delete(`t:${id}`); }
  }

  private updateStands(state: ShiftState, sel: Selection) {
    const hot: Record<string, string> = {};
    for (const r of state.active) if (!hot[r.stand] || r.priority === 'emergency') hot[r.stand] = r.priority;
    const parked = new Set(state.aircraft.filter(a => a.status === 'parked' && a.stand).map(a => a.stand!));
    for (const [id, g] of this.stands) {
      g.setAttribute('class', ['stand', hot[id] && 'hot', hot[id] === 'emergency' && 'em', sel.stand === id && 'sel', parked.has(id) && 'occupied'].filter(Boolean).join(' '));
    }
  }

  private updateRoutes(state: ShiftState, sel: Selection) {
    const req = sel.request != null ? state.active.find(r => r.id === sel.request) : null;
    const focusTech = req?.tech_id ?? sel.tech ?? this.opts.focusTech ?? null;
    const sig = JSON.stringify([focusTech, req?.id, state.techs.map(t => [t.id, t.route?.length, t.route?.[t.route.length - 1]]), state.aircraft.map(a => [a.id, a.route?.length])]);
    if (sig === this.sigs.routes) return;
    this.sigs.routes = sig;
    const g = this.layers.routes; g.replaceChildren();
    for (const t of state.techs) {
      if (!t.route || t.route.length < 2) continue;
      const route: Point[] = [[t.x, t.y], ...t.route.slice(1)];
      if (t.id === focusTech) {
        el('polyline', { class: 'route-casing', points: pts(route) }, g);
        el('polyline', { class: 'route', points: pts(route) }, g);
      } else el('polyline', { class: 'route-muted', points: pts(route) }, g);
    }
    for (const a of state.aircraft) if (a.route && a.route.length > 1) el('polyline', { class: 'ac-route', points: pts(a.route) }, g);
  }

  private updateBlocked(state: ShiftState) {
    const sig = state.blocked.join('|');
    if (sig === this.sigs.blocked) return;
    this.sigs.blocked = sig;
    const g = this.layers.blocked; g.replaceChildren();
    const ids = new Set(state.blocked);
    for (const s of this.segments) if (ids.has(s.id)) el('line', { class: 'blocked-edge', x1: s.ax, y1: s.ay, x2: s.bx, y2: s.by }, g);
  }

  private standPoint(state: ShiftState, standId: string) {
    const ac = state.aircraft.find(a => a.stand === standId && a.status !== 'departing');
    if (ac) return { x: ac.x, y: ac.y };
    const stand = this.air.stands.find(s => s.id === standId);
    return stand ? this.nodes.get(stand.node) ?? null : null;
  }

  private updateIsochrone(state: ShiftState, sel: Selection) {
    const req = sel.request != null ? state.active.find(r => r.id === sel.request) : null;
    const p = req ? this.standPoint(state, req.stand) : null;
    const key = p && req ? `${req.id}:${Math.round(p.x)}:${Math.round(p.y)}` : '';
    if (key === this.sigs.iso) return;
    this.sigs.iso = key;
    const g = this.layers.iso; g.replaceChildren();
    if (!p) return;
    const radius = 1260; // 15 min at a conservative 1.4 m/s walking speed
    el('circle', { class: 'iso-fill', cx: p.x, cy: p.y, r: radius }, g);
    el('circle', { class: 'iso-ring', cx: p.x, cy: p.y, r: radius }, g);
    el('circle', { class: 'iso-inner', cx: p.x, cy: p.y, r: radius / 2 }, g);
    this.tag(g, p.x, p.y - radius, 'ЗОНА 15:00', 'iso');
    this.tag(g, p.x, p.y - radius / 2, '7:30', 'iso dim');
    this.flyTo(p.x - radius * 1.1, p.y - radius * 1.1, radius * 2.2, radius * 2.2);
  }

  private updateComparison(state: ShiftState, sel: Selection, cmp: Comparison | null) {
    const key = cmp && sel.request === cmp.requestId ? `${cmp.requestId}:${cmp.human.length}:${cmp.system.length}` : '';
    if (key === this.sigs.cmp) return;
    this.sigs.cmp = key;
    const g = this.layers.compare; g.replaceChildren();
    if (!cmp || !key) return;
    el('polyline', { class: 'cmp-human', points: pts(cmp.human) }, g);
    el('polyline', { class: 'cmp-system-glow', points: pts(cmp.system) }, g);
    el('polyline', { class: 'cmp-system', points: pts(cmp.system) }, g);
    const mid = cmp.human[Math.floor(cmp.human.length / 2)];
    const end = cmp.system[cmp.system.length - 1];
    this.tag(g, mid[0], mid[1], `НА ГЛАЗ · ${cmp.humanName} · ${cmp.humanEta.toFixed(1)} мин`, 'human');
    this.tag(g, end[0], end[1], `АЛГОРИТМ · ${cmp.systemEta.toFixed(1)} мин`, 'system', 34);
    void state;
  }

  private tag(parent: Element, x: number, y: number, text: string, cls: string, dy = 0) {
    const g = el('g', { transform: `translate(${x} ${y})` }, parent);
    const m = el('g', { class: 'mk' }, g);
    const w = text.length * 6.4 + 22;
    el('rect', { class: `tag-bg ${cls}`, x: -w / 2, y: -12 + dy, width: w, height: 24, rx: 12 }, m);
    el('text', { class: `tag-text ${cls}`, y: 4 + dy }, m).textContent = text;
  }

  /* ---------------------------------------------------------------- motion */
  private moveTo(key: string, node: SVGGElement, x: number, y: number, a: number) {
    let m = this.motion.get(key);
    if (!m || this.opts.reduceMotion) {
      m = { node, x, y, a, tx: x, ty: y, ta: a, vx: 0, vy: 0, va: 0 };
      this.motion.set(key, m);
      node.setAttribute('transform', `translate(${x} ${y}) rotate(${a})`);
      return;
    }
    m.node = node; m.tx = x; m.ty = y; m.ta = a;
    if (!this.frame) { this.lastFrame = performance.now(); this.frame = requestAnimationFrame(this.loop); }
  }

  private lastFrame = 0;
  private loop = (now: number) => {
    const dt = Math.min(0.033, Math.max(0.001, (now - this.lastFrame) / 1000));
    this.lastFrame = now;
    this.frame = this.animate(dt) && !this.destroyed ? requestAnimationFrame(this.loop) : 0;
  };

  private animate(dt: number) {
    let moving = false;
    for (const m of this.motion.values()) {
      const dx = m.tx - m.x, dy = m.ty - m.y, da = ((m.ta - m.a + 540) % 360) - 180;
      if (Math.abs(dx) < 0.05 && Math.abs(dy) < 0.05 && Math.abs(da) < 0.1 && Math.abs(m.vx) + Math.abs(m.vy) < 0.1) {
        if (m.x !== m.tx || m.y !== m.ty) { m.x = m.tx; m.y = m.ty; m.a = m.ta; m.node.setAttribute('transform', `translate(${m.x} ${m.y}) rotate(${m.a})`); }
        continue;
      }
      m.vx += (dx * 40 - m.vx * 12) * dt; m.vy += (dy * 40 - m.vy * 12) * dt; m.va += (da * 18 - m.va * 8) * dt;
      m.x += m.vx * dt; m.y += m.vy * dt; m.a += m.va * dt;
      m.node.setAttribute('transform', `translate(${m.x.toFixed(2)} ${m.y.toFixed(2)}) rotate(${m.a.toFixed(1)})`);
      moving = true;
    }
    return moving;
  }

  /* ---------------------------------------------------------------- viewport */
  private apply() {
    const { x, y, w, h } = this.vb;
    this.svg.setAttribute('viewBox', `${x} ${y} ${w} ${h}`);
    const k = this.bounds.width ? Math.max(w / this.bounds.width, h / this.bounds.height) : 1;
    this.svg.style.setProperty('--mk', k.toFixed(4));
    this.svg.classList.toggle('zoom-wide', k > 1.6);
    this.svg.classList.toggle('zoom-far', k > 3.2);
    this.cb.onView?.(k);
  }

  scale() { return this.bounds.width ? Math.max(this.vb.w / this.bounds.width, this.vb.h / this.bounds.height) : 1; }

  fitStands(animate = true) {
    const ps = this.air.stands.map(s => this.nodes.get(s.node)).filter(Boolean) as { x: number; y: number }[];
    if (!ps.length) { this.setView({ x: 0, y: 0, w: this.air.width, h: this.air.height }, animate); return; }
    const xs = ps.map(p => p.x), ys = ps.map(p => p.y);
    const pad = 320;
    this.flyTo(Math.min(...xs) - pad, Math.min(...ys) - pad, Math.max(...xs) - Math.min(...xs) + pad * 2, Math.max(...ys) - Math.min(...ys) + pad * 2, animate);
  }

  fitAll() { this.flyTo(0, 0, this.air.width, this.air.height); }

  focusOn(x: number, y: number, metersAcross = 900) { this.flyTo(x - metersAcross / 2, y - metersAcross / 2, metersAcross, metersAcross); }

  /** Animated camera move that keeps the box clear of floating panels (insets in px). */
  flyTo(x: number, y: number, w: number, h: number, animate = true) {
    const b = this.bounds.width ? this.bounds : this.svg.getBoundingClientRect();
    const inset = { top: 150, right: document.body.classList.contains('panel-open') ? 440 : 80, bottom: 80, left: 40 };
    if (b.width < 700) { inset.top = 120; inset.right = 20; inset.left = 20; inset.bottom = 120; }
    const uw = Math.max(200, b.width - inset.left - inset.right), uh = Math.max(200, b.height - inset.top - inset.bottom);
    const k = Math.max(w / uw, h / uh);
    const cx = x + w / 2 + ((inset.right - inset.left) / 2) * k;
    const cy = y + h / 2 + ((inset.bottom - inset.top) / 2) * k;
    this.setView({ x: cx - (b.width * k) / 2, y: cy - (b.height * k) / 2, w: b.width * k, h: b.height * k }, animate);
  }

  private setView(to: { x: number; y: number; w: number; h: number }, animate = true) {
    cancelAnimationFrame(this.flyFrame);
    if (!animate || this.opts.reduceMotion || this.vb.w <= 1) { this.vb = to; this.apply(); return; }
    const from = { ...this.vb }, t0 = performance.now(), dur = 650;
    const step = (now: number) => {
      const k = Math.min(1, (now - t0) / dur), e = 1 - Math.pow(1 - k, 3);
      this.vb = { x: from.x + (to.x - from.x) * e, y: from.y + (to.y - from.y) * e, w: from.w + (to.w - from.w) * e, h: from.h + (to.h - from.h) * e };
      this.apply();
      if (k < 1) this.flyFrame = requestAnimationFrame(step);
    };
    this.flyFrame = requestAnimationFrame(step);
  }

  zoom(factor: number, cx?: number, cy?: number) {
    cancelAnimationFrame(this.flyFrame);
    const full = this.air.width;
    const nw = Math.min(Math.max(this.vb.w * factor, full / 25), full * 1.3), k = nw / this.vb.w;
    cx ??= this.vb.x + this.vb.w / 2; cy ??= this.vb.y + this.vb.h / 2;
    this.vb = { x: cx - (cx - this.vb.x) * k, y: cy - (cy - this.vb.y) * k, w: nw, h: this.vb.h * k };
    this.apply();
  }

  private toMap(clientX: number, clientY: number) {
    const b = this.bounds;
    const k = Math.max(this.vb.w / b.width, this.vb.h / b.height);
    // preserveAspectRatio xMidYMid meet
    const ox = (b.width * k - this.vb.w) / 2, oy = (b.height * k - this.vb.h) / 2;
    return { x: this.vb.x - ox + (clientX - b.left) * k, y: this.vb.y - oy + (clientY - b.top) * k };
  }

  private nearestEdge(x: number, y: number, max: number) {
    let best: Segment | null = null, bestD = max * max;
    for (const s of this.segments) {
      const dx = s.bx - s.ax, dy = s.by - s.ay, len = dx * dx + dy * dy || 1;
      const t = Math.max(0, Math.min(1, ((x - s.ax) * dx + (y - s.ay) * dy) / len));
      const px = s.ax + t * dx - x, py = s.ay + t * dy - y, d = px * px + py * py;
      if (d < bestD) { bestD = d; best = s; }
    }
    return best;
  }

  nearestNode(x: number, y: number) {
    let best: string | null = null, bestD = Infinity;
    for (const [id, n] of this.nodes) { const d = (n.x - x) ** 2 + (n.y - y) ** 2; if (d < bestD) { bestD = d; best = id; } }
    return best ? { id: best, ...this.nodes.get(best)! } : null;
  }

  pointToMap(clientX: number, clientY: number) { return this.toMap(clientX, clientY); }

  private bindEvents() {
    const svg = this.svg;
    const pointers = new Map<number, { x: number; y: number }>();
    let drag: { x: number; y: number; vx: number; vy: number; moved: boolean } | null = null;
    let pinch: { d: number; w: number; cx: number; cy: number } | null = null;
    let panFrame = 0, pending: { dx: number; dy: number } | null = null;

    svg.addEventListener('wheel', e => {
      e.preventDefault();
      const p = this.toMap(e.clientX, e.clientY);
      this.zoom(Math.exp(e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)), p.x, p.y);
    }, { passive: false });

    svg.addEventListener('pointerdown', e => {
      this.bounds = svg.getBoundingClientRect();
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      svg.setPointerCapture(e.pointerId);
      cancelAnimationFrame(this.flyFrame);
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        const mid = this.toMap((a.x + b.x) / 2, (a.y + b.y) / 2);
        pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), w: this.vb.w, cx: mid.x, cy: mid.y };
        drag = null;
      } else drag = { x: e.clientX, y: e.clientY, vx: this.vb.x, vy: this.vb.y, moved: false };
    });
    svg.addEventListener('pointermove', e => {
      if (!pointers.has(e.pointerId)) return;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pinch && pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        const target = pinch.w * (pinch.d / Math.max(1, d));
        this.zoom(target / this.vb.w, pinch.cx, pinch.cy);
        return;
      }
      if (!drag) return;
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (!drag.moved && Math.abs(dx) + Math.abs(dy) > 5) { drag.moved = true; svg.classList.add('dragging'); }
      if (!drag.moved) return;
      pending = { dx, dy };
      if (!panFrame) panFrame = requestAnimationFrame(() => {
        panFrame = 0;
        if (!drag || !pending) return;
        const k = Math.max(this.vb.w / this.bounds.width, this.vb.h / this.bounds.height);
        this.vb.x = drag.vx - pending.dx * k; this.vb.y = drag.vy - pending.dy * k;
        this.apply();
      });
    });
    const end = (e: PointerEvent) => {
      pointers.delete(e.pointerId);
      if (pinch) { if (pointers.size < 2) pinch = null; drag = null; return; }
      const d = drag; drag = null; svg.classList.remove('dragging');
      if (!d || d.moved || e.type === 'pointercancel') return;
      this.click(e);
    };
    svg.addEventListener('pointerup', end);
    svg.addEventListener('pointercancel', end);
  }

  private click(e: PointerEvent) {
    if (this.opts.pointSelection && this.cb.onPoint) {
      const point = this.toMap(e.clientX, e.clientY);
      this.cb.onPoint(point.x, point.y);
      return;
    }
    const target = document.elementFromPoint(e.clientX, e.clientY);
    const tech = target?.closest('[data-tech]');
    if (tech) return this.cb.onTech?.(Number(tech.getAttribute('data-tech')));
    const ac = target?.closest('[data-aircraft]');
    if (ac) return this.cb.onAircraft?.(Number(ac.getAttribute('data-aircraft')));
    const stand = target?.closest('[data-stand]');
    if (stand) return this.cb.onStand?.(stand.getAttribute('data-stand')!);
    if (this.opts.interactiveEdges && (this.opts.edgeMode || e.altKey || e.shiftKey)) {
      const p = this.toMap(e.clientX, e.clientY);
      const edge = this.nearestEdge(p.x, p.y, 8 * this.scale());
      if (edge) return this.cb.onEdge?.(edge.id, edge.name);
    }
    this.cb.onEmpty?.();
  }
}

export const pathLength = (p: Point[]) => p.reduce((s, q, i) => i ? s + Math.hypot(q[0] - p[i - 1][0], q[1] - p[i - 1][1]) : 0, 0);
