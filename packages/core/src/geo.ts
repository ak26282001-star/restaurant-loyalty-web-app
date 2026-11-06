export type LatLng = { lat: number; lng: number };

const EARTH_RADIUS_M = 6_371_000;
const toRad = (deg: number) => (deg * Math.PI) / 180;

/** Great-circle distance in metres (haversine). */
export function distanceMeters(a: LatLng, b: LatLng): number {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h));
}

/** True when `point` lies within the location's geofence. Locations without coordinates never match. */
export function withinGeofence(
  point: LatLng,
  location: { lat: number | null; lng: number | null; geofence_m: number },
): boolean {
  if (location.lat == null || location.lng == null) return false;
  return distanceMeters(point, { lat: location.lat, lng: location.lng }) <= location.geofence_m;
}
