import { describe, expect, it } from 'vitest';
import { formatCoordinates, haversineMeters } from './geospatial';

describe('geospatial calculations', () => {
  it('returns zero distance for the same coordinate', () => {
    expect(haversineMeters([55.97278, 37.41472], [55.97278, 37.41472])).toBe(0);
  });

  it('uses a great-circle distance in metres', () => {
    expect(haversineMeters([0, 0], [0, 1])).toBeCloseTo(111_194.93, 1);
  });

  it('keeps the source decimal precision instead of padding zeros', () => {
    expect(formatCoordinates(55.9724317, 37.4, 'DD')).toBe('55.9724317, 37.4');
  });

  it('formats coordinates as DMS and Geo URI', () => {
    expect(formatCoordinates(55.97278, 37.41472, 'DMS')).toBe('55°58′22.01″N 37°24′52.99″E');
    expect(formatCoordinates(55.97278, 37.41472, 'GEO URI')).toBe('geo:55.97278,37.41472');
  });
});
