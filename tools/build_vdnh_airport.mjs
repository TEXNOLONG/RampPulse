import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const geoDir = path.join(root, 'web/src/features/map/data/it2026');
const read = name => JSON.parse(fs.readFileSync(path.join(geoDir, `${name}.json`), 'utf8'));
const roads = read('roads');
const boundaries = read('airport_boundaries');
const objects = read('objects');
const center = [55.8330053, 37.628713];
const metersLat = 111_132;
const metersLon = 111_320 * Math.cos(center[0] * Math.PI / 180);
const features = roads.features.filter(feature => feature.geometry.type === 'LineString');
const allCoordinates = features.flatMap(feature => feature.geometry.coordinates);
const boundaryCoordinates = boundaries.features.flatMap(feature => {
  const polygons = feature.geometry.type === 'MultiPolygon' ? feature.geometry.coordinates : [feature.geometry.coordinates];
  return polygons.flatMap(polygon => polygon.flatMap(ring => ring));
});
const coordinates = [...allCoordinates, ...boundaryCoordinates];
const minLon = Math.min(...coordinates.map(point => point[0])) - 0.0005;
const maxLon = Math.max(...coordinates.map(point => point[0])) + 0.0005;
const minLat = Math.min(...coordinates.map(point => point[1])) - 0.0005;
const maxLat = Math.max(...coordinates.map(point => point[1])) + 0.0005;
const origin = [maxLat, minLon];
const xy = ([lon, lat]) => [(lon - origin[1]) * metersLon, (origin[0] - lat) * metersLat];

const nodes = [];
const buckets = new Map();
const snapMeters = 2.5;
function nodeFor(point) {
  const [x, y] = xy(point);
  const gx = Math.floor(x / snapMeters), gy = Math.floor(y / snapMeters);
  let nearest = null, nearestDistance = snapMeters;
  for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
    for (const id of buckets.get(`${gx + dx}:${gy + dy}`) ?? []) {
      const candidate = nodes[id - 1];
      const distance = Math.hypot(candidate.x - x, candidate.y - y);
      if (distance < nearestDistance) { nearest = candidate; nearestDistance = distance; }
    }
  }
  if (nearest) return nearest.id;
  const id = `V${String(nodes.length + 1).padStart(5, '0')}`;
  nodes.push({ id, x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10 });
  const key = `${gx}:${gy}`;
  buckets.set(key, [...(buckets.get(key) ?? []), nodes.length]);
  return id;
}

const edges = [];
const routeNodes = { taxi: [], service: [] };
for (const feature of features) {
  const points = feature.geometry.coordinates;
  const ids = points.map(nodeFor);
  const type = feature.properties.type;
  const kind = type === 'taxi' ? 'taxiway' : type === 'pedestrian' ? 'pedestrian' : type === 'runway' ? 'runway' : 'service';
  const speed = type === 'taxi' ? 20 : type === 'service' ? 10 : 5;
  for (let i = 0; i < ids.length - 1; i++) {
    if (ids[i] === ids[i + 1]) continue;
    edges.push({ id: `V${feature.properties.fid}-${i + 1}`, a: ids[i], b: ids[i + 1], kind, name: `${kind} ${feature.properties.id}`, vehicle_kmh: speed, walk_allowed: type !== 'runway', vehicle_allowed: type === 'taxi' || type === 'service' });
  }
  if (type === 'taxi') routeNodes.taxi.push(...ids);
  if (type === 'service') routeNodes.service.push(...ids);
}

const readFinal = name => JSON.parse(fs.readFileSync(path.join(geoDir, '..', 'final', name + '.json'), 'utf8')).features;
function nearest(point, ids) {
  const [x, y] = xy(point);
  return ids.reduce((best, id) => {
    const n = nodes[Number(id.slice(1)) - 1];
    const distance = Math.hypot(n.x - x, n.y - y);
    return distance < best.distance ? { id, distance } : best;
  }, { id: null, distance: Infinity }).id;
}
const stands = readFinal('aircrafts_positions').map((feature, index) => ({
  id: 'VDN-' + String(index + 1).padStart(2, '0'),
  node: nearest(feature.geometry.coordinates, routeNodes.taxi),
  heading: 0,
  registration: feature.properties.object_id,
  model: feature.properties.name,
}));
const bases = readFinal('engineers_positions').map((feature, index) => ({
  id: 'BASE' + (index + 1),
  name: feature.properties.tabel_id,
  node: nearest(feature.geometry.coordinates, routeNodes.service),
}));
const arrivalNodes = [...new Set(routeNodes.taxi)];
const areas = [];
for (const feature of objects.features) {
  const polygons = feature.geometry.type === 'MultiPolygon' ? feature.geometry.coordinates : [feature.geometry.coordinates];
  const name = feature.properties.name;
  for (const polygon of polygons) {
    const points = polygon[0].map(point => xy(point));
    if (points.length >= 3) areas.push({ kind: /ангар/i.test(name) ? 'hangar' : /терминал/i.test(name) ? 'terminal' : 'apron', name, points });
  }
}
const runways = features.filter(feature => feature.properties.type === 'runway').map(feature => ({ name: String(feature.properties.id), width: 42, points: feature.geometry.coordinates.map(xy) }));
const width = Math.ceil((maxLon - origin[1]) * metersLon);
const height = Math.ceil((origin[0] - minLat) * metersLat);
const airport = {
  name: 'ВДНХ · IT2026 Aero GeoData',
  source: 'Локальные GeoJSON проекта IT2026',
  width,
  height,
  geo: { iata: 'VDN', latitude: center[0], longitude: center[1], coordinate_source: 'IT2026 VDNH GeoJSON' },
  geo_transform: { origin_latitude: origin[0], origin_longitude: origin[1], meters_per_degree_latitude: metersLat, meters_per_degree_longitude: metersLon },
  nodes,
  edges,
  stands,
  bases,
  areas,
  runways,
  arrival_nodes: arrivalNodes,
  vehicle_engineers: [1, 3, 5],
};
const destination = path.join(root, 'data/airport_vdnh.json');
fs.writeFileSync(destination, `${JSON.stringify(airport)}\n`);
console.log(`Wrote ${destination}: ${nodes.length} nodes, ${edges.length} links, ${stands.length} stands, ${bases.length} bases.`);
