import * as Location from "expo-location";

/** One-time permission for the native receiver's passive last-known snapshot. */
export async function enableLocationContext(): Promise<string> {
  const current = await Location.getForegroundPermissionsAsync();
  if (current.status === "granted") return "granted";
  const asked = await Location.requestForegroundPermissionsAsync();
  return asked.status;
}


export interface LocationProbe {
  permission: string;
  lastKnown: { lat: number; lng: number; accuracy: number | null; ageMs: number } | null;
  current: { lat: number; lng: number; accuracy: number | null } | null;
  error?: string;
}

/** User-triggered diagnostic. The ledger itself still uses only passive fixes. */
export async function locationProbe(): Promise<LocationProbe> {
  const perm = await Location.getForegroundPermissionsAsync();
  if (perm.status !== "granted") return { permission: perm.status, lastKnown: null, current: null };
  const now = Date.now();
  try {
    const last = await Location.getLastKnownPositionAsync({ maxAge: 30 * 60_000, requiredAccuracy: 2000 });
    const lastKnown = last ? {
      lat: last.coords.latitude, lng: last.coords.longitude,
      accuracy: last.coords.accuracy ?? null, ageMs: Math.max(0, now - Number(last.timestamp)),
    } : null;
    let current: LocationProbe["current"] = null;
    if (!lastKnown) {
      const pos = await Promise.race([
        Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 8000)),
      ]);
      if (pos) current = { lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy ?? null };
    }
    return { permission: perm.status, lastKnown, current };
  } catch (e) {
    return { permission: perm.status, lastKnown: null, current: null, error: String(e).slice(0, 180) };
  }
}
