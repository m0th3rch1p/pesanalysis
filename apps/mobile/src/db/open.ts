import * as SQLite from "expo-sqlite";
import * as SecureStore from "expo-secure-store";
import { autoMergeNameOnlyVariants, backfillAirtimeBundles, refreshPendingLabelSuggestions, backfillFulizaFromSms, migrate, promoteAirtimeBundles, repairDataIntegrity, resetAllData, seedTaxonomy, type DbAdapter } from "@yako/core";
import { randomHex } from "../../modules/yako-sms";
import { startup } from "../startup";

/**
 * Encrypted ledger. Key = 32 random bytes from Android's SecureRandom, kept in
 * Android Keystore-backed SecureStore. SQLCipher is compiled into expo-sqlite
 * (`expo.sqlite.useSQLCipher=true`), so `PRAGMA key` must be the first statement.
 * Synchronous because @yako/core's Store contract is synchronous (one SMS = one
 * short transaction); 1,279 backfill rows still complete in a few seconds.
 */
const KEY_NAME = "yako.db.key";
const DB_NAME = "ledger.db";

function getOrCreateKey(): string {
  const existing = SecureStore.getItem(KEY_NAME);
  if (existing) return existing;
  const key = randomHex(32);
  SecureStore.setItem(KEY_NAME, key);
  return key;
}

export function asDbAdapter(db: SQLite.SQLiteDatabase): DbAdapter {
  return {
    exec: (sql) => db.execSync(sql),
    run: (sql, params) => db.runSync(sql, params as SQLite.SQLiteBindParams),
    get: (sql, params) => db.getFirstSync(sql, params as SQLite.SQLiteBindParams),
    all: (sql, params) => db.getAllSync(sql, params as SQLite.SQLiteBindParams),
  };
}

export interface Ledger {
  db: SQLite.SQLiteDatabase;
  /** SQLCipher version string, or null if encryption is NOT active. */
  cipherVersion: string | null;
}

export function openLedger(): Ledger {
  startup("ledger open start");
  const db = SQLite.openDatabaseSync(DB_NAME);
  const key = getOrCreateKey();
  db.execSync(`PRAGMA key = "x'${key}'";`);
  // First real read: fails loudly if the key is wrong or SQLCipher is missing.
  const row = db.getFirstSync<{ cipher_version: string }>("PRAGMA cipher_version;");
  // PRAGMA foreign_keys is per connection and defaults off; the schema script only sets it once.
  db.execSync("PRAGMA foreign_keys = ON;");
  const adapter = asDbAdapter(db);
  migrate(adapter);
  seedTaxonomy(adapter);
  repairDataIntegrity(adapter);
  try { autoMergeNameOnlyVariants(adapter); } catch { /* identity cleanup is best-effort */ }
  try { refreshPendingLabelSuggestions(adapter); } catch { /* suggestions are best-effort */ }
  try { backfillFulizaFromSms(adapter); } catch { /* optional; new messages still update it */ }
  try { backfillAirtimeBundles(adapter); } catch { /* optional; new messages still bundle at ingest */ }
  try { promoteAirtimeBundles(adapter); } catch { /* optional; user rules always win */ }
  startup("ledger ready");
  return { db, cipherVersion: row?.cipher_version ?? null };
}

/** Wipes the ledger (debug only). Keeps the key so the file stays decryptable. */
export function resetLedger(db: SQLite.SQLiteDatabase): void {
  const adapter = asDbAdapter(db);
  resetAllData(adapter);
  seedTaxonomy(adapter);
}
