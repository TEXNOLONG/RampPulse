import { useEffect, useRef, useState } from 'react';
import { Plus, Minus, Maximize2, Crosshair, Construction, Navigation } from 'lucide-react';
import { MapEngine, type Comparison, type MapCallbacks, type Selection } from './engine';
import { useOps } from '../../store/ops';
import { usePrefs } from '../../store/prefs';
import { cx } from '../../lib/format';

interface Props extends MapCallbacks {
  selection: Selection;
  waypoints?: string[];
  comparison?: Comparison | null;
  interactiveEdges?: boolean;
  focusTech?: number | null;
  compact?: boolean;
  onReady?(engine: MapEngine): void;
  className?: string;
}

export function AirportMap({ waypoints, selection, comparison = null, interactiveEdges = false, focusTech = null, compact, onReady, className, ...callbacks }: Props) {
  const svgRef = useRef<SVGSVGElement>(null);
  const engineRef = useRef<MapEngine | null>(null);
  const cbRef = useRef(callbacks); cbRef.current = callbacks;
  const airport = useOps(s => s.airport);
  const state = useOps(s => s.state);
  const tick = useOps(s => s.tick);
  const prefs = usePrefs();
  const [scale, setScale] = useState(1);
  const [edgeMode, setEdgeMode] = useState(false);

  useEffect(() => {
    if (!svgRef.current || !airport) return;
    const engine = new MapEngine(svgRef.current, airport, {
      onPoint: (x, y) => cbRef.current.onPoint?.(x, y),
      onStand: id => cbRef.current.onStand?.(id),
      onTech: id => cbRef.current.onTech?.(id),
      onAircraft: id => cbRef.current.onAircraft?.(id),
      onEdge: (id, name) => cbRef.current.onEdge?.(id, name),
      onEmpty: () => cbRef.current.onEmpty?.(),
      onView: k => setScale(k),
    }, { pointSelection: Boolean(callbacks.onPoint), interactiveEdges, showLabels: prefs.mapLabels, showRoutes: prefs.mapRoutes, reduceMotion: prefs.reduceMotion, focusTech });
    engineRef.current = engine;
    onReady?.(engine);
    return () => { engine.destroy(); engineRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [airport]);

  useEffect(() => {
    engineRef.current?.setOptions({ pointSelection: Boolean(callbacks.onPoint), showLabels: prefs.mapLabels, showRoutes: prefs.mapRoutes, reduceMotion: prefs.reduceMotion, focusTech, interactiveEdges, edgeMode });
  }, [prefs.mapLabels, prefs.mapRoutes, prefs.reduceMotion, focusTech, interactiveEdges, edgeMode, Boolean(callbacks.onPoint)]);

  useEffect(() => {
    if (state) engineRef.current?.update(state, selection, comparison);
  }, [state, tick, selection.request, selection.tech, selection.aircraft, selection.stand, comparison]);

  useEffect(() => { engineRef.current?.setWaypoints(waypoints ?? []); }, [airport, waypoints]);

  const scaleBar = niceScale(scale);
  const me = focusTech != null ? state?.techs.find(t => t.id === focusTech) : null;

  return (
    <div className={cx('map-stage', compact && 'compact', className)}>
      <svg ref={svgRef} className="map-svg" role="img" aria-label="Карта перрона" />
      <div className="map-vignette" aria-hidden />
      <div className="map-controls glass">
        {me && <button onClick={() => engineRef.current?.focusOn(me.x, me.y, 700)} title="Где я" aria-label="Где я"><Navigation size={17} /></button>}
        <button onClick={() => engineRef.current?.zoom(0.75)} title="Приблизить" aria-label="Приблизить"><Plus size={17} /></button>
        <button onClick={() => engineRef.current?.zoom(1.33)} title="Отдалить" aria-label="Отдалить"><Minus size={17} /></button>
        <span className="sep" />
        <button onClick={() => engineRef.current?.fitStands()} title="Перрон целиком" aria-label="Перрон целиком"><Crosshair size={17} /></button>
        <button onClick={() => engineRef.current?.fitAll()} title="Весь аэродром" aria-label="Весь аэродром"><Maximize2 size={16} /></button>
        {interactiveEdges && <>
          <span className="sep" />
          <button className={cx(edgeMode && 'on danger')} onClick={() => setEdgeMode(v => !v)} title="Режим перекрытия РД: клик по рулёжке перекрывает или открывает её" aria-pressed={edgeMode}><Construction size={17} /></button>
        </>}
      </div>
      {edgeMode && <div className="edge-hint glass">Режим перекрытия: нажмите на рулёжную дорожку, чтобы закрыть или открыть её</div>}
      {!compact && (
        <div className="map-scale glass">
          <span className="north">N</span>
          <span className="rule" style={{ width: scaleBar.px }} />
          <b>{scaleBar.label}</b>
        </div>
      )}
    </div>
  );
}

function niceScale(metersPerPx: number) {
  const desired = 90 * metersPerPx;
  const pow = Math.pow(10, Math.floor(Math.log10(Math.max(1, desired))));
  const u = desired / pow;
  const nice = (u < 1.5 ? 1 : u < 3.5 ? 2 : u < 7.5 ? 5 : 10) * pow;
  return { px: nice / metersPerPx, label: nice >= 1000 ? `${(nice / 1000).toFixed(nice % 1000 ? 1 : 0)} км` : `${Math.round(nice)} м` };
}
