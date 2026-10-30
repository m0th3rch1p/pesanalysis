import type { SQLiteDatabase } from "expo-sqlite";
import { Contact, ContactField, ContactsSortOrder, getPermissionsAsync, requestPermissionsAsync } from "expo-contacts";
import { linkContacts, type LocalContact } from "@yako/core";
import { asDbAdapter } from "./db/open";

/** Local-only contact unmasking. Never uploads or dials. */
export async function syncMaskedContacts(db: SQLiteDatabase): Promise<{ permission: string; contacts: number; linked: number }> {
  const current = await getPermissionsAsync();
  const perm = current.status === "granted" ? current : await requestPermissionsAsync();
  if (perm.status !== "granted") return { permission: perm.status, contacts: 0, linked: 0 };
  // Expo SDK 58's class-based Contacts API; the legacy namespace throws at runtime.
  const details = await Contact.getAllDetails([ContactField.FULL_NAME, ContactField.PHONES], {
    limit: 10000,
    sortOrder: ContactsSortOrder.GivenName,
  });
  const rows: LocalContact[] = [];
  for (const c of details) {
    const phones = (c.phones ?? [])
      .map((p) => p.number?.replace(/[^\d+]/g, "") ?? "")
      .filter(Boolean);
    if (!phones.length) continue;
    rows.push({ contactId: String(c.id ?? c.fullName ?? phones[0]), name: c.fullName ?? null, phones });
  }
  return { permission: perm.status, contacts: rows.length, linked: linkContacts(asDbAdapter(db), rows).linked };
}
