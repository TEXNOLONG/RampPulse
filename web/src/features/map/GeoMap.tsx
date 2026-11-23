import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { Cloud, Copy, Crosshair, LocateFixed, Navigation, Plane, Radio, RefreshCw, Satellite, Square, X } from 'lucide-react';
import { get } from '../../lib/api';
import { useGps } from '../../lib/gps';
import { formatCoordinates, haversineMeters } from '../../lib/geospatial';
import type { Airport, Aircraft, EngineerLocation } from '../../lib/types';
import { cx } from '../../lib/format';
import { WeatherPanel, type WeatherData, type WeatherLocationMode, type WeatherStatus } from './WeatherPanel';
import boundaries from './data/it2026/airport_boundaries.json';
import objects from './data/it2026/objects.json';
import roads from './data/it2026/roads.json';
import serviceZones from './data/it2026/service_zones.json';

interface LiveAircraft {
  source_type: 'REAL'; icao24: string; callsign: string | null; registration: string | null;
  aircraft_type: string | null; description: string | null; latitude: number; longitude: number;
  altitude_m: number | null; altitude_geom_m: number | null; ground_speed_mps: number | null;
  heading_deg: number | null; vertical_rate_mps: number | null; squawk: string | null;
  on_ground: boolean | null; last_seen_ms: number | null; freshness_s: number | null; data_source: string;
}
interface Snapshot { provider: string; license: string; status: 'LIVE' | 'STALE' | 'OFFLINE'; enabled: boolean; fetched_at_ms: number | null; age_s: number | null; poll_interval_s: number; aircraft: LiveAircraft[]; error: string | null }
interface Props { airport: Airport; simulated: Aircraft[]; onClose?(): void; panelOpen?: boolean; importedAirport?: boolean; engineerLocations?: EngineerLocation[]; manageGps?: boolean }
const IT2026_CENTER: [number, number] = [55.8330053, 37.628713];
const icon = (glyph: string, color: string, rotate = 0) => L.divIcon({
  className: 'geo-marker-shell',
  html: `<span class="geo-marker" style="--marker-color:${color};transform:rotate(${rotate}deg)">${glyph}</span>`,
  iconSize: [28, 28], iconAnchor: [14, 14],
});

const aircraftIcon = (color: string, heading = 0) => L.divIcon({
  className: 'geo-marker-shell',
  html: `<span class="geo-marker geo-aircraft-marker" style="--marker-color:${color};transform:rotate(${heading}deg)"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.5 14 10l7 4v2l-7-1.5v4l2 1.5v1.5L12 20l-4 1.5V20l2-1.5v-4L3 16v-2l7-4 2-7.5Z"/></svg></span>`,
  iconSize: [32, 32], iconAnchor: [16, 16],
});

const num = (value: number | null | undefined, digits = 0) => value == null || !Number.isFinite(value) ? '—' : value.toFixed(digits);
const bearingText = (value: number | null) => value == null ? '—' : `${Math.round(value)}°`;
function copyCoordinates(lat: number, lon: number, format: 'DD' | 'DMS' | 'GEO URI') {
  void navigator.clipboard?.writeText(formatCoordinates(lat, lon, format)).catch(() => undefined);
}
function toGeo(airport: Airport, x: number, y: number): [number, number] | null {
  const t = airport.geo_transform;
  if (!t) return null;
  return [t.origin_latitude - y / t.meters_per_degree_latitude, t.origin_longitude + x / t.meters_per_degree_longitude];
}

function drawAirport(L: typeof import('leaflet'), airport: Airport, group: L.LayerGroup) {
  if (!airport.geo_transform) return;
  const areaColors: Record<string, { fill: string; line: string }> = {
    terminal: { fill: '#17171d', line: '#35353e' },
    hangar: { fill: '#111116', line: '#28282f' },
    apron: { fill: '#0c0c10', line: '#17171d' },
  };
  for (const area of airport.areas ?? []) {
    const points = area.points.map(([x, y]) => toGeo(airport, x, y)).filter((point): point is [number, number] => point !== null);
    if (points.length < 3) continue;
    const colors = areaColors[area.kind] ?? areaColors.apron;
    const polygon = L.polygon(points, { color: colors.line, weight: area.kind === 'terminal' ? 1.8 : 1, opacity: 0.88, fillColor: colors.fill, fillOpacity: 0.98, interactive: Boolean(area.name) });
    if (area.name) polygon.bindTooltip(area.name, { sticky: true, permanent: area.kind === 'terminal', direction: 'center', className: 'geo-dark-tooltip' });
    polygon.addTo(group);
  }
  const parking = (airport.parking ?? []).map(item => item.points.map(([x, y]) => toGeo(airport, x, y)).filter((point): point is [number, number] => point !== null)).filter(points => points.length > 2);
  if (parking.length) L.polyline(parking, { color: '#292930', weight: 0.8, opacity: 0.68, interactive: false }).addTo(group);
  for (const runway of airport.runways ?? []) {
    const points = runway.points.map(([x, y]) => toGeo(airport, x, y)).filter((point): point is [number, number] => point !== null);
    if (points.length > 1) {
      const half = Math.max(12, (runway.width ?? 45) / 2);
      const left: [number, number][] = [], right: [number, number][] = [];
      for (let i = 0; i < runway.points.length; i++) {
        const previous = runway.points[Math.max(0, i - 1)], next = runway.points[Math.min(runway.points.length - 1, i + 1)];
        const dx = next[0] - previous[0], dy = next[1] - previous[1], length = Math.hypot(dx, dy) || 1;
        const ox = -dy / length * half, oy = dx / length * half, [x, y] = runway.points[i];
        const a = toGeo(airport, x + ox, y + oy), b = toGeo(airport, x - ox, y - oy);
        if (a && b) { left.push(a); right.push(b); }
      }
      const runwayPolygon = [...left, ...right.reverse()];
      if (runwayPolygon.length >= 4) L.polygon(runwayPolygon, { color: '#25252c', weight: 1, opacity: 0.95, fillColor: '#19191f', fillOpacity: 0.98 }).addTo(group);
      L.polyline(points, { color: '#55555e', weight: 1.2, opacity: 0.72, dashArray: '18 20', interactive: false }).bindTooltip(`ВПП ${runway.name ?? ''}`, { sticky: true, className: 'geo-dark-tooltip' }).addTo(group);
    }
  }
  const nodes = new Map(airport.nodes.map(node => [node.id, node]));
  const taxiways: [number, number][][] = [];
  for (const edge of airport.edges.filter(edge => edge.kind === 'taxiway' || edge.kind === 'taxilane' || edge.kind === 'apron')) {
    const from = nodes.get(edge.a), to = nodes.get(edge.b);
    if (!from || !to) continue;
    const a = toGeo(airport, from.x, from.y), b = toGeo(airport, to.x, to.y);
    if (a && b) taxiways.push([a, b]);
  }
  if (taxiways.length) {
    L.polyline(taxiways, { color: '#17171d', weight: 8, opacity: 0.96, lineCap: 'round', lineJoin: 'round', interactive: false }).addTo(group);
    L.polyline(taxiways, { color: '#45454e', weight: 1.1, opacity: 0.78, lineCap: 'round', lineJoin: 'round', interactive: false }).addTo(group);
  }
  for (const base of airport.bases ?? []) {
    const node = nodes.get(base.node), point = node && toGeo(airport, node.x, node.y);
    if (point) L.circleMarker(point, { radius: 4, color: '#92929d', weight: 1, fillColor: '#18181d', fillOpacity: 1 }).bindTooltip(base.name, { permanent: true, direction: 'bottom', offset: [0, 8], className: 'geo-dark-tooltip' }).addTo(group);
  }
  for (const stand of airport.stands ?? []) {
    const node = nodes.get(stand.node), point = node && toGeo(airport, node.x, node.y);
    if (point) L.circleMarker(point, { radius: 5, color: '#666671', weight: 1, fillColor: '#18181e', fillOpacity: 0.9 }).bindTooltip(stand.id.replace(/^ВС-/, ''), { permanent: true, direction: 'bottom', offset: [0, 7], className: 'geo-dark-tooltip geo-stand-label' }).addTo(group);
  }
}

function bearingDegrees(from: [number, number], to: [number, number]) {
  const rad = (degrees: number) => degrees * Math.PI / 180;
  const lat1 = rad(from[0]), lat2 = rad(to[0]), dLon = rad(to[1] - from[1]);
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

export function GeoMap({ airport, simulated, onClose, panelOpen = false, importedAirport = false, engineerLocations = [], manageGps = true }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const realGroup = useRef<L.LayerGroup | null>(null);
  const simGroup = useRef<L.LayerGroup | null>(null);
  const gpsGroup = useRef<L.LayerGroup | null>(null);
  const airportGroup = useRef<L.LayerGroup | null>(null);
  const engineerGroup = useRef<L.LayerGroup | null>(null);
  const realMarkers = useRef(new Map<string, L.Marker>());
  const simMarkers = useRef(new Map<number, L.Marker>());
  const history = useRef(new Map<string, [number, number][]>());
  const gpsHistory = useRef<[number, number][]>([]);
  const trails = useRef(new Map<string, L.Polyline>());
  const follow = useGps(s => s.follow);
  const rawGps = useGps(s => s.raw);
  const filteredGps = useGps(s => s.filtered);
  const gpsStatus = useGps(s => s.status);
  const gpsError = useGps(s => s.error);
  const jumpDetected = useGps(s => s.jumpDetected);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [weather, setWeather] = useState<WeatherData | null>(null);
  const [weatherOpen, setWeatherOpen] = useState(false);
  const [weatherClosing, setWeatherClosing] = useState(false);
  const [weatherRefreshing, setWeatherRefreshing] = useState(false);
  const [weatherError, setWeatherError] = useState<string | null>(null);
  const [weatherLocationMode, setWeatherLocationMode] = useState<WeatherLocationMode>('airport');
  const [weatherLocation, setWeatherLocation] = useState<[number, number]>(() => importedAirport ? IT2026_CENTER : [airport.geo?.latitude ?? 55.97278, airport.geo?.longitude ?? 37.41472]);
  const [selected, setSelected] = useState<string | null>(null);
  const [showReal, setShowReal] = useState(true);
  const [showSimulation, setShowSimulation] = useState(false);
  const [showGps, setShowGps] = useState(true);
  const [aircraftGpsMode, setAircraftGpsMode] = useState(false);
  const [aircraftCenter, setAircraftCenter] = useState<[number, number]>(() => importedAirport ? IT2026_CENTER : [airport.geo?.latitude ?? 55.97278, airport.geo?.longitude ?? 37.41472]);
  const weatherButtonRef = useRef<HTMLButtonElement>(null);
  const weatherCloseTimerRef = useRef(0);
  const weatherRequestRef = useRef<{ key: string; requestId: number; promise: Promise<void> } | null>(null);
  const weatherRequestIdRef = useRef(0);
  const selectedAircraft = useMemo(() => snapshot?.aircraft.find(item => item.icao24 === selected) ?? null, [snapshot, selected]);
  const airportLat = importedAirport ? IT2026_CENTER[0] : airport.geo?.latitude ?? 55.97278;
  const airportLon = importedAirport ? IT2026_CENTER[1] : airport.geo?.longitude ?? 37.41472;
  const weatherLatitude = weatherLocation[0];
  const weatherLongitude = weatherLocation[1];

  useEffect(() => {
    if (!host.current || map.current) return;
    const instance = L.map(host.current, { zoomControl: false, attributionControl: false, preferCanvas: true }).setView([airportLat, airportLon], 11);
    L.control.zoom({ position: 'bottomright' }).addTo(instance);
    realGroup.current = L.layerGroup().addTo(instance);
    simGroup.current = L.layerGroup().addTo(instance);
    gpsGroup.current = L.layerGroup().addTo(instance);
    airportGroup.current = L.layerGroup().addTo(instance);
    engineerGroup.current = L.layerGroup().addTo(instance);
    const bounds = L.latLngBounds([]);
    if (importedAirport) {
      const addGeoLayer = (data: GeoJSON.GeoJsonObject, options: L.GeoJSONOptions = {}) => {
        const layer = L.geoJSON(data, options).addTo(airportGroup.current!);
        const layerBounds = layer.getBounds();
        if (layerBounds.isValid()) bounds.extend(layerBounds);
      };
      addGeoLayer(boundaries as GeoJSON.GeoJsonObject, {
        style: { color: '#46464f', weight: 1.5, opacity: 0.8, fillColor: '#0b0b0f', fillOpacity: 0.74, dashArray: '7 6' },
        onEachFeature: (_feature, layer) => layer.bindTooltip('Граница ВДНХ', { sticky: true, className: 'geo-dark-tooltip' }),
      });
      addGeoLayer(serviceZones as GeoJSON.GeoJsonObject, {
        style: { color: '#3f7664', weight: 1, opacity: 0.74, fillColor: '#18382f', fillOpacity: 0.26, dashArray: '4 5' },
        onEachFeature: (feature, layer) => layer.bindTooltip(`Зона обслуживания ${feature.properties?.id ?? ''}`, { sticky: true, className: 'geo-dark-tooltip' }),
      });
      addGeoLayer(roads as GeoJSON.GeoJsonObject, {
        filter: feature => feature?.properties?.type === 'runway' || feature?.properties?.type === 'taxi',
        style: feature => ({ color: '#0b0b0e', weight: feature?.properties?.type === 'runway' ? 15 : 8, opacity: 0.98, lineCap: 'round', lineJoin: 'round' }),
      });
      addGeoLayer(roads as GeoJSON.GeoJsonObject, {
        style: feature => {
          const type = feature?.properties?.type;
          if (type === 'runway') return { color: '#666670', weight: 6, opacity: 0.84, lineCap: 'round', lineJoin: 'round', dashArray: '18 20' };
          if (type === 'taxi') return { color: '#393941', weight: 2.2, opacity: 0.92, lineCap: 'round', lineJoin: 'round' };
          if (type === 'service') return { color: '#426b5c', weight: 1.35, opacity: 0.8, dashArray: '6 5', lineCap: 'round' };
          return { color: '#565660', weight: 1.1, opacity: 0.74, dashArray: '2 6', lineCap: 'round' };
        },
        onEachFeature: (feature, layer) => {
          const id = feature.properties?.id;
          const type = feature.properties?.type;
          const name = type === 'runway' ? `ВПП ${id ?? ''}`
            : type === 'taxi' ? `Рулёжная дорожка ${id ?? ''}`
              : type === 'service' ? `Сервисный маршрут ${id ?? ''}` : `Пешеходный маршрут ${id ?? ''}`;
          layer.bindTooltip(name, { sticky: true, className: 'geo-dark-tooltip' });
        },
      });
      addGeoLayer(objects as GeoJSON.GeoJsonObject, {
        style: feature => ({ color: '#41414a', weight: 1, opacity: 0.86, fillColor: feature?.properties?.id === 2 ? '#1b1b22' : '#111116', fillOpacity: 0.98 }),
        onEachFeature: (feature, layer) => { const name = feature.properties?.name; if (name) layer.bindTooltip(String(name), { sticky: true, className: 'geo-dark-tooltip' }); },
      });
    } else {
      drawAirport(L, airport, airportGroup.current);
      if (airport.geo_transform) {
      for (const [x, y] of [[0, 0], [airport.width, 0], [0, airport.height], [airport.width, airport.height]] as [number, number][]) {
        const point = toGeo(airport, x, y);
        if (point) bounds.extend(point);
      }
      }
    }
    map.current = instance;
    let fitted = false;
    const fitMap = () => {
      if (fitted || !bounds.isValid() || !host.current || !host.current.clientWidth || !host.current.clientHeight) return;
      instance.invalidateSize({ pan: false, animate: false });
      instance.fitBounds(bounds.pad(importedAirport ? 0.055 : 0.05), { animate: false, maxZoom: importedAirport ? 17 : 16 });
      fitted = true;
    };
    const fitFrame = window.requestAnimationFrame(fitMap);
    const resizeObserver = new ResizeObserver(fitMap);
    resizeObserver.observe(host.current);
    return () => { window.cancelAnimationFrame(fitFrame); resizeObserver.disconnect(); instance.remove(); map.current = null; realGroup.current = null; simGroup.current = null; gpsGroup.current = null; airportGroup.current = null; engineerGroup.current = null; realMarkers.current.clear(); simMarkers.current.clear(); history.current.clear(); trails.current.clear(); };
  }, [airport, airportLat, airportLon, importedAirport]);

  useEffect(() => () => {
    const status = useGps.getState().status;
    if (manageGps && status !== 'IDLE' && status !== 'STOPPED') useGps.getState().stop();
  }, [manageGps]);

  useEffect(() => () => window.clearTimeout(weatherCloseTimerRef.current), []);
  useEffect(() => {
    if (panelOpen) { setWeatherOpen(false); setWeatherClosing(false); }
  }, [panelOpen]);

  useEffect(() => {
    if (weatherLocationMode === 'airport') setWeatherLocation([airportLat, airportLon]);
  }, [airportLat, airportLon, weatherLocationMode]);

  useEffect(() => {
    if (!aircraftGpsMode) setAircraftCenter([airportLat, airportLon]);
  }, [airportLat, airportLon, aircraftGpsMode]);

  useEffect(() => {
    if (!rawGps) return;
    if (weatherLocationMode === 'my') {
      setWeatherLocation(previous => haversineMeters(previous, [rawGps.latitude, rawGps.longitude]) >= 250 ? [rawGps.latitude, rawGps.longitude] : previous);
    }
    if (aircraftGpsMode) {
      setAircraftCenter(previous => haversineMeters(previous, [rawGps.latitude, rawGps.longitude]) >= 5_000 ? [rawGps.latitude, rawGps.longitude] : previous);
    }
  }, [rawGps, weatherLocationMode, aircraftGpsMode]);

  const loadWeather = useCallback((force = false) => {
    const requestKey = `${weatherLatitude.toFixed(3)}:${weatherLongitude.toFixed(3)}`;
    if (weatherRequestRef.current?.key === requestKey) return weatherRequestRef.current.promise;
    const requestId = ++weatherRequestIdRef.current;
    setWeatherRefreshing(true);
    setWeatherError(null);
    const query = new URLSearchParams({ lat: String(weatherLatitude), lon: String(weatherLongitude) });
    if (force) query.set('refresh', 'true');
    const request = (async () => {
      try {
        const response = await get<WeatherData>(`/api/weather/current?${query.toString()}`);
        if (requestId !== weatherRequestIdRef.current) return;
        setWeather(response);
        setWeatherError(response.error);
      } catch (error) {
        if (requestId !== weatherRequestIdRef.current) return;
        const message = error instanceof Error ? error.message : 'Weather service is unavailable.';
        setWeatherError(message);
        setWeather(previous => previous && Math.abs(previous.latitude - weatherLatitude) < 0.01 && Math.abs(previous.longitude - weatherLongitude) < 0.01
          ? { ...previous, error: message, error_code: 'OFFLINE' }
          : null);
      }
    })().finally(() => {
      if (requestId === weatherRequestIdRef.current) {
        weatherRequestRef.current = null;
        setWeatherRefreshing(false);
      }
    });
    weatherRequestRef.current = { key: requestKey, requestId, promise: request };
    return request;
  }, [weatherLatitude, weatherLongitude]);

  useEffect(() => {
    let active = true;
    let timer = 0;
    const poll = async () => {
      await loadWeather();
      if (active) timer = window.setTimeout(poll, Math.max(60, weather?.cache_seconds ?? 600) * 1000);
    };
    void poll();
    return () => { active = false; window.clearTimeout(timer); };
  }, [loadWeather]);

  useEffect(() => {
    if (weatherLocationMode !== 'map' || !map.current) return;
    const instance = map.current;
    let timer = 0;
    const moved = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        const center = instance.getCenter();
        const next: [number, number] = [center.lat, center.lng];
        setWeatherLocation(previous => haversineMeters(previous, next) >= 5_000 ? next : previous);
      }, 1_200);
    };
    instance.on('moveend', moved);
    return () => { instance.off('moveend', moved); window.clearTimeout(timer); };
  }, [weatherLocationMode, airportLat, airportLon]);

  useEffect(() => {
    let active = true;
    let timer = 0;
    let pollInterval = 180;
    const load = async () => {
      try {
        const response = await get<Snapshot>(`/api/aircraft/live?lat=${aircraftCenter[0]}&lon=${aircraftCenter[1]}`);
        pollInterval = Math.max(120, response.poll_interval_s || 180);
        if (active) setSnapshot(response);
      } catch (error) {
        pollInterval = Math.max(120, snapshot?.poll_interval_s ?? 180);
        if (active) setSnapshot({ provider: 'adsb.lol', license: 'ODbL-1.0', status: 'OFFLINE', enabled: false, fetched_at_ms: null, age_s: null, poll_interval_s: 180, aircraft: [], error: error instanceof Error ? error.message : 'Не удалось получить live aircraft.' });
      } finally {
        if (active) timer = window.setTimeout(load, pollInterval * 1000);
      }
    };
    void load();
    return () => { active = false; window.clearTimeout(timer); };
  }, [aircraftCenter[0], aircraftCenter[1]]);

  useEffect(() => {
    if (!map.current || !realGroup.current) return;
    const group = realGroup.current;
    if (!showReal) { group.clearLayers(); realMarkers.current.clear(); history.current.clear(); trails.current.clear(); return; }
    const visible = snapshot?.aircraft ?? [];
    const ids = new Set(visible.map(item => item.icao24));
    for (const [id, marker] of realMarkers.current) if (!ids.has(id)) { group.removeLayer(marker); realMarkers.current.delete(id); history.current.delete(id); const trail = trails.current.get(id); if (trail) group.removeLayer(trail); trails.current.delete(id); }
    for (const item of visible) {
      const position: [number, number] = [item.latitude, item.longitude];
      const previous = history.current.get(item.icao24) ?? [];
      if (!previous.length || haversineMeters(previous[previous.length - 1], position) > 15) {
        previous.push(position); if (previous.length > 60) previous.shift(); history.current.set(item.icao24, previous);
      }
      if (previous.length > 1) {
        const color = snapshot?.status === 'LIVE' ? '#F4F4F5' : '#fbbf24';
        let trail = trails.current.get(item.icao24);
        if (!trail) { trail = L.polyline(previous, { color, weight: 2, opacity: 0.58, dashArray: '3 7' }); trails.current.set(item.icao24, trail); group.addLayer(trail); }
        else trail.setLatLngs(previous).setStyle({ color });
      }
      let marker = realMarkers.current.get(item.icao24);
      if (!marker) {
        marker = L.marker(position, { icon: aircraftIcon('#F4F4F5', item.heading_deg ?? 0), keyboard: true })
          .on('click', () => { setWeatherOpen(false); setWeatherClosing(false); setSelected(item.icao24); map.current?.flyTo(position, Math.max(map.current.getZoom(), 12), { duration: 0.7 }); });
        realMarkers.current.set(item.icao24, marker); group.addLayer(marker);
      } else {
        marker.setLatLng(position);
        marker.setIcon(aircraftIcon(snapshot?.status === 'LIVE' ? '#F4F4F5' : '#fbbf24', item.heading_deg ?? 0));
      }
      marker.bindTooltip(`${item.callsign || item.icao24} · ${item.aircraft_type || 'type n/a'}`);
    }
  }, [snapshot, showReal]);

  useEffect(() => {
    if (!simGroup.current) return;
    const group = simGroup.current;
    if (!showSimulation) { group.clearLayers(); simMarkers.current.clear(); return; }
    const ids = new Set(simulated.map(item => item.id));
    for (const [id, marker] of simMarkers.current) if (!ids.has(id)) { group.removeLayer(marker); simMarkers.current.delete(id); }
    for (const aircraft of simulated) {
      const point = toGeo(airport, aircraft.x, aircraft.y);
      if (!point) continue;
      let marker = simMarkers.current.get(aircraft.id);
      if (!marker) {
        marker = L.marker(point, { icon: aircraftIcon('#F4F4F5', aircraft.heading), opacity: 0.8 });
        marker.bindTooltip(`${aircraft.flight} · SIMULATION`);
        simMarkers.current.set(aircraft.id, marker); group.addLayer(marker);
      } else { marker.setLatLng(point); marker.setIcon(aircraftIcon('#F4F4F5', aircraft.heading)); }
    }
  }, [airport, simulated, showSimulation]);

  useEffect(() => {
    if (!map.current || !gpsGroup.current) return;
    const group = gpsGroup.current;
    group.clearLayers();
    if (!showGps) return;
    if (!rawGps || !filteredGps) { gpsHistory.current = []; return; }
    const markerFix = jumpDetected && filteredGps ? filteredGps : rawGps;
    const point: [number, number] = [markerFix.latitude, markerFix.longitude];
    const previous = gpsHistory.current;
    if (!previous.length || haversineMeters(previous[previous.length - 1], point) >= 3) {
      previous.push(point);
      if (previous.length > 120) previous.shift();
    }
    if (previous.length > 1) L.polyline(previous, { color: '#34d399', weight: 3, opacity: 0.72 }).addTo(group);
    L.circle([rawGps.latitude, rawGps.longitude], { radius: rawGps.accuracy, color: '#34d399', weight: 1, fillColor: '#34d399', fillOpacity: 0.08 }).addTo(group);
    L.marker(point, { icon: icon('●', '#34d399', rawGps.heading ?? 0), zIndexOffset: 1000 })
      .bindTooltip(`GPS raw ${rawGps.latitude}, ${rawGps.longitude} · ±${num(rawGps.accuracy, 1)} m`)
      .addTo(group);
    if (follow) map.current.setView(point, Math.max(map.current.getZoom(), 14), { animate: true, duration: 0.45 });
  }, [rawGps, filteredGps, jumpDetected, showGps, follow]);

  useEffect(() => {
    const group = engineerGroup.current;
    if (!group) return;
    group.clearLayers();
    for (const location of engineerLocations) {
      const point: [number, number] = [location.latitude, location.longitude];
      if (location.track.length > 1) L.polyline(location.track, { color: '#60a5fa', weight: 3, opacity: 0.75 }).addTo(group);
      L.circle(point, { radius: Math.max(15, location.accuracy), color: '#60a5fa', weight: 1, opacity: 0.45, fillOpacity: 0.05 }).addTo(group);
      L.marker(point, { icon: icon('●', '#60a5fa'), zIndexOffset: 900 })
        .bindTooltip(`${location.name} · GPS ±${Math.round(location.accuracy)} m`)
        .addTo(group);
    }
  }, [engineerLocations]);

  const centerGps = () => { if (rawGps) map.current?.setView([rawGps.latitude, rawGps.longitude], Math.max(map.current.getZoom(), 14)); };
  const centerAirport = () => {
    useGps.getState().setFollow(false);
    setAircraftGpsMode(false);
    setWeatherLocationMode('airport');
    map.current?.setView([airportLat, airportLon], 11);
  };
  const startGps = () => { useGps.getState().start(); setShowGps(true); };
  const stopGps = () => useGps.getState().stop();
  const applyMyLocation = () => {
    setShowGps(true);
    setAircraftGpsMode(true);
    useGps.getState().setFollow(true);
    setWeatherLocationMode('my');
    if (rawGps) {
      setWeatherLocation([rawGps.latitude, rawGps.longitude]);
      map.current?.setView([rawGps.latitude, rawGps.longitude], Math.max(map.current.getZoom(), 14));
      return;
    }
    startGps();
  };
  const closeWeather = () => {
    if (!weatherOpen || weatherClosing) return;
    setWeatherClosing(true);
    weatherCloseTimerRef.current = window.setTimeout(() => {
      setWeatherOpen(false);
      setWeatherClosing(false);
      weatherButtonRef.current?.focus();
    }, 170);
  };
  const selectWeatherLocation = (nextMode: WeatherLocationMode) => {
    if (nextMode === 'airport') setWeatherLocation([airportLat, airportLon]);
    if (nextMode === 'map') {
      const center = map.current?.getCenter();
      if (center) setWeatherLocation([center.lat, center.lng]);
    }
    if (nextMode === 'my' && rawGps) setWeatherLocation([rawGps.latitude, rawGps.longitude]);
    setWeatherLocationMode(nextMode);
  };
  const distance = rawGps && selectedAircraft ? haversineMeters([rawGps.latitude, rawGps.longitude], [selectedAircraft.latitude, selectedAircraft.longitude]) : null;
  const statusText = snapshot?.status ?? 'CONNECTING';
  const mode = showReal && showSimulation ? 'HYBRID' : showReal ? 'REAL DATA' : showSimulation ? 'SIMULATION' : 'LAYERS OFF';
  const weatherAgeMs = weather?.fetched_at_ms == null ? null : Date.now() - weather.fetched_at_ms;
  const weatherStatus: WeatherStatus = weatherRefreshing
    ? (weather?.fetched_at_ms ? 'UPDATING' : 'CONNECTING')
    : weather?.error_code === 'RATE_LIMITED'
      ? 'UPDATING'
    : weatherError
      ? (weather?.fetched_at_ms ? 'STALE' : weather?.error_code === 'NOT_CONFIGURED' ? 'ERROR' : 'OFFLINE')
      : weather?.error_code === 'AUTH_OR_QUOTA' || weather?.error_code === 'INVALID_LOCATION' || weather?.error_code === 'INVALID_RESPONSE'
        ? 'ERROR'
        : weather && weatherAgeMs != null && weatherAgeMs > Math.max(60, weather.cache_seconds) * 1000
          ? 'STALE'
          : weather?.fetched_at_ms ? 'LIVE' : 'CONNECTING';
  const weatherLocationName = weatherLocationMode === 'airport'
    ? airport.name
    : weatherLocationMode === 'map' ? 'Центр карты' : 'Моё местоположение';
  const weatherIcao = weatherLocationMode === 'airport' ? airport.geo?.icao ?? airport.geo?.iata ?? null : null;
  const trackBearing = rawGps && selectedAircraft ? bearingDegrees([rawGps.latitude, rawGps.longitude], [selectedAircraft.latitude, selectedAircraft.longitude]) : null;
  const aircraftEtaMinutes = distance != null && selectedAircraft?.ground_speed_mps && selectedAircraft.ground_speed_mps > 0
    ? distance / selectedAircraft.ground_speed_mps / 60
    : null;

  return <div className={cx('geo-map-stage', weatherOpen && 'weather-open')}>
    <div ref={host} className={cx('geo-map', importedAirport && 'geo-map-imported')} aria-label="Интерактивная географическая карта аэропорта и реальных воздушных судов" />
    <div className="geo-toolbar glass">
      <div className="geo-layer-list">
        <button className={cx(showReal && 'on')} onClick={() => setShowReal(value => !value)}><Radio size={14} /> REAL {snapshot?.aircraft.length ?? 0}</button>
        <button className={cx(showSimulation && 'on')} onClick={() => setShowSimulation(value => !value)}><Satellite size={14} /> SIMULATION</button>
        <button className={cx(showGps && 'on')} onClick={() => setShowGps(value => !value)}><LocateFixed size={14} /> GPS {gpsStatus}</button>
      </div>
      <span className={cx('geo-feed-status', statusText.toLowerCase())}><i /> {statusText}</span>
      <b className="geo-mode-label">{mode}</b>
      <small>{snapshot?.provider ?? 'adsb.lol'} · {snapshot?.age_s == null ? 'waiting' : `${snapshot.age_s}s`} · {snapshot?.poll_interval_s ?? 180}s</small>
      {snapshot?.error && <small className="geo-feed-error" title={snapshot.error}>{snapshot.error}</small>}
    </div>
    <button ref={weatherButtonRef} className={cx('geo-weather-toggle glass', weatherOpen && 'on', weatherStatus.toLowerCase())} onClick={() => { setSelected(null); setWeatherClosing(false); setWeatherOpen(true); void loadWeather(); }} aria-expanded={weatherOpen} aria-controls="geo-weather-panel" aria-label={`Weather · ${weatherStatus}${weather?.temperature_c == null ? '' : ` · ${weather.temperature_c}°C`}`}>
      <Cloud size={17} /><span>WEATHER</span><b>{weather?.temperature_c == null ? '—°' : `${weather.temperature_c}°`}</b><i title={weatherStatus} />
    </button>
    {weatherOpen && <WeatherPanel id="geo-weather-panel" closing={weatherClosing} weather={weather} status={weatherStatus} error={weatherError} locationName={weatherLocationName} icao={weatherIcao} latitude={weatherLatitude} longitude={weatherLongitude} locationMode={weatherLocationMode} gpsAvailable={!!filteredGps} refreshing={weatherRefreshing} onLocationMode={selectWeatherLocation} onRefresh={() => { void loadWeather(true); }} onClose={closeWeather} />}
    {rawGps && showGps && <div className="geo-gps-card glass">
      <span className={cx('geo-feed-status', gpsStatus.toLowerCase())}><i /> GPS {gpsStatus}</span>
      <div className="geo-gps-coords"><span>LATITUDE<b>{rawGps.latitude}</b></span><span>LONGITUDE<b>{rawGps.longitude}</b></span></div>
      <div className="geo-gps-stats">
        <span>ALTITUDE<b>{rawGps.altitude == null ? '—' : `${rawGps.altitude.toFixed(1)} m`}</b></span>
        <span>ALT ACCURACY<b>{rawGps.altitudeAccuracy == null ? '—' : `±${rawGps.altitudeAccuracy.toFixed(1)} m`}</b></span>
        <span>ACCURACY<b>±{rawGps.accuracy.toFixed(1)} m</b></span>
        <span>SPEED<b>{rawGps.speed == null ? '—' : `${rawGps.speed.toFixed(1)} m/s`}</b></span>
        <span>HEADING<b>{bearingText(rawGps.heading)}</b></span>
        <span>LAST UPDATE<b>{new Date(rawGps.timestamp).toLocaleTimeString()}</b></span>
      </div>
      {useGps.getState().jumpDetected && <small className="geo-jump">Position jump detected; filtered marker retained while RAW fix is shown.</small>}
      <div className="geo-gps-footer"><span>FILTERED {filteredGps?.latitude}, {filteredGps?.longitude}</span><div className="geo-copy-row">{(['DD', 'DMS', 'GEO URI'] as const).map(format => <button key={format} onClick={() => copyCoordinates(rawGps.latitude, rawGps.longitude, format)} title={`Copy raw GPS as ${format}`}><Copy size={12} /> {format}</button>)}</div></div>
    </div>}
    <div className="geo-tools glass">
      {gpsStatus === 'ACTIVE' || gpsStatus === 'LOW_ACCURACY' || gpsStatus === 'STALE' ? <button title="Остановить GPS" aria-label="Остановить GPS" onClick={stopGps}><Square size={15} /></button> : <button title="Запросить доступ к геоданным" aria-label="Запросить доступ к геоданным" onClick={startGps}><LocateFixed size={16} /></button>}
      <button className={cx(aircraftGpsMode && 'on')} title="Применить моё местоположение: карта, погода и реальные борта" aria-label="Применить моё местоположение: карта, погода и реальные борта" onClick={applyMyLocation}><Plane size={16} /></button>
      <button title={follow ? 'Выключить слежение' : 'Следовать за GPS'} className={cx(follow && 'on')} disabled={!rawGps} onClick={() => useGps.getState().setFollow(!follow)}><Crosshair size={16} /></button>
      <button title="Центрировать на GPS" disabled={!rawGps} onClick={centerGps}><Navigation size={16} /></button>
      <button title="Центрировать на аэропорт" onClick={centerAirport}><RefreshCw size={15} /></button>
    </div>
    {gpsError && <div className="geo-gps-error glass">{gpsError}<button onClick={startGps}>Повторить</button></div>}
    {!importedAirport && !airport.geo_transform && showSimulation && simulated.length > 0 && <div className="geo-map-note glass">На геокарте отображаются реальные борта и GPS. Для бортов SIMULATION остаётся локальная схема перрона: у текущей схемы нет сохранённой геопривязки.</div>}
    {selectedAircraft && <aside className="geo-aircraft-card glass">
      <button className="geo-card-close" aria-label="Закрыть карточку" onClick={() => setSelected(null)}><X size={16} /></button>
      <span className="eyebrow">REAL AIRCRAFT · {selectedAircraft.data_source}</span>
      <h3>{selectedAircraft.callsign || 'Unknown callsign'}</h3>
      <div className="geo-aircraft-grid">
        <span>ICAO24<b>{selectedAircraft.icao24.toUpperCase()}</b></span>
        <span>REGISTRATION<b>{selectedAircraft.registration || '—'}</b></span>
        <span>TYPE<b>{selectedAircraft.aircraft_type || selectedAircraft.description || '—'}</b></span>
        <span>POSITION<b>{selectedAircraft.latitude}, {selectedAircraft.longitude}</b></span>
        <span>ALTITUDE<b>{selectedAircraft.altitude_m == null ? selectedAircraft.on_ground ? 'GROUND' : '—' : `${Math.round(selectedAircraft.altitude_m)} m`}</b></span>
        <span>SPEED<b>{selectedAircraft.ground_speed_mps == null ? '—' : `${selectedAircraft.ground_speed_mps.toFixed(1)} m/s`}</b></span>
        <span>HEADING<b>{bearingText(selectedAircraft.heading_deg)}</b></span>
        <span>DISTANCE FROM GPS<b>{distance == null ? 'GPS off' : `${(distance / 1000).toFixed(1)} km`}</b></span>
        <span>BEARING FROM GPS<b>{trackBearing == null ? 'GPS off' : bearingText(trackBearing)}</b></span>
        <span>ETA AT CURRENT SPEED<b>{aircraftEtaMinutes == null ? '—' : `~${Math.round(aircraftEtaMinutes)} min`}</b></span>
        <span>VERTICAL RATE<b>{selectedAircraft.vertical_rate_mps == null ? '—' : `${selectedAircraft.vertical_rate_mps.toFixed(1)} m/s`}</b></span>
        <span>SQUAWK<b>{selectedAircraft.squawk || '—'}</b></span>
        <span>LAST POSITION<b>{selectedAircraft.freshness_s == null ? '—' : `${selectedAircraft.freshness_s.toFixed(1)} s ago`}</b></span>
      </div>
      <div className="geo-copy-row">{(['DD', 'DMS', 'GEO URI'] as const).map(format => <button className="geo-copy" key={format} onClick={() => copyCoordinates(selectedAircraft.latitude, selectedAircraft.longitude, format)}><Copy size={13} /> {format}</button>)}</div>
    </aside>}
    <div className="geo-attribution glass"><b className="geo-provider-logo">{importedAirport ? 'ВДНХ' : 'SVO'}</b><span>{importedAirport ? 'ВДНХ · IT2026 Aero GeoData' : 'Шереметьево · локальная схема'} · авиационные данные adsb.lol</span></div>
    {onClose && <button className="geo-close glass" onClick={onClose} aria-label="Закрыть геокарту"><X size={16} /></button>}
  </div>;
}
