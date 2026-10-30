import type { SQLiteDatabase } from "expo-sqlite";
import { EntityTypes, getCalendarPermissions, getCalendars, listEvents, requestCalendarPermissions } from "expo-calendar";
import { getPermissionsAsync as getContactsPermissions } from "expo-contacts";
import * as Location from "expo-location";
import { attachCalendarEvents, pruneCalendarContext } from "@yako/core";
import { asDbAdapter } from "./db/open";
import { syncMaskedContacts } from "./contacts";
import { enableLocationContext } from "./context";

const DAY = 86_400_000;

function get(db: SQLiteDatabase, key: string): string | null {
  try { return db.getFirstSync<{ value: string }>(`SELECT value FROM meta WHERE key = ?`, [key])?.value ?? null; } catch { return null; }
}
function set(db: SQLiteDatabase, key: string, value: string): void {
  try { db.runSync(`INSERT INTO meta (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`, [key, value]); } catch { /* non-fatal */ }
}

export interface ConnectorStatus {
  calendar: { enabled: boolean; permission: string; events: number; updated: number; lastSync: number | null };
  contacts: { enabled: boolean; permission: string; contacts: number; linked: number; lastSync: number | null };
  location: { enabled: boolean; permission: string; lastSync: number | null };
}

export async function connectorStatus(db: SQLiteDatabase): Promise<ConnectorStatus> {
  const [cal, con, loc] = await Promise.all([
    getCalendarPermissions().catch(() => ({ status: "undetermined" })),
    getContactsPermissions().catch(() => ({ status: "undetermined" })),
    Location.getForegroundPermissionsAsync().catch(() => ({ status: "undetermined" })),
  ]);
  return {
    calendar: {
      enabled: get(db, "connector_calendar") === "1", permission: cal.status,
      events: Number(get(db, "connector_calendar_events") ?? 0),
      updated: Number(get(db, "connector_calendar_updated") ?? 0),
      lastSync: Number(get(db, "connector_calendar_last") ?? 0) || null,
    },
    contacts: {
      enabled: get(db, "connector_contacts") === "1", permission: con.status,
      contacts: Number(get(db, "connector_contacts_count") ?? 0),
      linked: Number(get(db, "connector_contacts_linked") ?? 0),
      lastSync: Number(get(db, "connector_contacts_last") ?? 0) || null,
    },
    location: {
      enabled: get(db, "connector_location") === "1", permission: loc.status,
      lastSync: Number(get(db, "connector_location_last") ?? 0) || null,
    },
  };
}

/** Read calendar events around the ledger window and attach them to overlapping transactions. */
function toMs(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return value;
  return new Date(String(value ?? "")).getTime();
}

export async function connectCalendar(
  db: SQLiteDatabase, request = true,
): Promise<{ permission: string; calendars: number; events: number; updated: number; created: number; error?: string }> {
  try {
    const current = await getCalendarPermissions();
    const perm = request && current.status !== "granted" ? await requestCalendarPermissions() : current;
    if (perm.status !== "granted") return { permission: perm.status, calendars: 0, events: 0, updated: 0, created: 0 };
    const now = Date.now();
    const calendars = await getCalendars(EntityTypes.EVENT);
    const ids = calendars.map((c) => c.id).filter(Boolean);
    let raw: Awaited<ReturnType<typeof listEvents>> = [];
    let lastError: string | undefined;
    for (const id of ids) {
      try {
        const batch = await listEvents([id], new Date(now - 120 * DAY), new Date(now + 30 * DAY));
        raw = raw.concat(batch);
      } catch (e) {
        lastError = String(e).slice(0, 160);
      }
    }
    const byId = new Map<string, { id: string; title: string; startAt: number; endAt: number }>();
    for (const e of raw) {
      const startAt = toMs(e.startDate), endAt = toMs(e.endDate);
      const title = (e.title ?? "").trim();
      if (!e.id || !title || !Number.isFinite(startAt) || !Number.isFinite(endAt) || endAt <= startAt) continue;
      byId.set(String(e.id), { id: String(e.id), title, startAt, endAt });
    }
    const events = [...byId.values()];
    const r = attachCalendarEvents(asDbAdapter(db), events, now);
    pruneCalendarContext(asDbAdapter(db), events.map((e) => e.id), now);
    set(db, "connector_calendar", "1");
    set(db, "connector_calendar_events", String(events.length));
    set(db, "connector_calendar_updated", String(r.updated + r.created));
    set(db, "connector_calendar_last", String(now));
    return { permission: perm.status, calendars: calendars.length, events: events.length, ...r, ...(lastError ? { error: lastError } : {}) };
  } catch (e) {
    return { permission: "error", calendars: 0, events: 0, updated: 0, created: 0, error: String(e).slice(0, 240) };
  }
}

export async function connectContacts(db: SQLiteDatabase): Promise<{ permission: string; contacts: number; linked: number }> {
  const r = await syncMaskedContacts(db);
  if (r.permission === "granted") set(db, "connector_contacts", "1");
  set(db, "connector_contacts_count", String(r.contacts));
  set(db, "connector_contacts_linked", String(r.linked));
  set(db, "connector_contacts_last", String(Date.now()));
  return r;
}

export async function connectLocation(db: SQLiteDatabase): Promise<string> {
  const status = await enableLocationContext();
  set(db, "connector_location", status === "granted" ? "1" : "0");
  set(db, "connector_location_last", String(Date.now()));
  return status;
}

/** Called after the ledger opens; only uses previously granted permissions, never prompts. */
export async function autoSyncConnectors(db: SQLiteDatabase): Promise<void> {
  try {
    if (get(db, "connector_calendar") === "1") {
      const p = await getCalendarPermissions();
      if (p.status === "granted") await connectCalendar(db, false);
    }
    if (get(db, "connector_contacts") === "1") {
      const p = await getContactsPermissions();
      if (p.status === "granted") await connectContacts(db);
    }
  } catch { /* connectors are optional */ }
}
