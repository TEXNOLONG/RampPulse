export type LatLon = [number, number];

export function haversineMeters(a: LatLon, b: LatLon) {
  const radians = (degrees: number) => degrees * Math.PI / 180;
  const dLat = radians(b[0] - a[0]);
  const dLon = radians(b[1] - a[1]);
  const lat1 = radians(a[0]), lat2 = radians(b[0]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 6_371_000 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}
function dms(value: number, positive: string, negative: string) {
  const absolute = Math.abs(value), degrees = Math.floor(absolute), minutesRaw = (absolute - degrees) * 60;
  const minutes = Math.floor(minutesRaw), seconds = ((minutesRaw - minutes) * 60).toFixed(2);
  return `${degrees}°${minutes}′${seconds}″${value < 0 ? negative : positive}`;
}

export function formatCoordinates(lat: number, lon: number, format: 'DD' | 'DMS' | 'GEO URI') {
  if (format === 'DMS') return `${dms(lat, 'N', 'S')} ${dms(lon, 'E', 'W')}`;
  if (format === 'GEO URI') return `geo:${lat},${lon}`;
  return `${lat}, ${lon}`;
}
