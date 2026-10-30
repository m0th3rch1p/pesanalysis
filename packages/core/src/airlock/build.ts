/**
 * Z2 airlock (D39): the only data shape allowed to leave the phone for a third party.
 * Month x direction x taxonomy-label x amount-band aggregates, with k-suppression.
 * Custom/user labels are folded into "Other" so a label like "Divorce lawyer" cannot leak.
 * No counterparty, no note, no SMS body, no place, no exact timestamp.
 */
import type { DbAdapter } from "../db/migrate.js";
import { SEED_LABELS } from "../labels/taxonomy.js";
import type { AirlockConfig, AirlockManifest } from "./types.js";

const MONTH_EXPR = `strftime('%Y-%m', t.occurred_at / 1000, 'unixepoch', '+3 hours')`;
const BANDS: Array<{ label: string; min: number; max: number }> = [
  { label: "<100", min: 0, max: 10_000 },
  { label: "100-499", min: 10_000, max: 50_000 },
  { label: "500-1999", min: 50_000, max: 200_000 },
  { label: "2000-9999", min: 200_000, max: 1_000_000 },
  { label: "10000+", min: 1_000_000, max: Number.MAX_SAFE_INTEGER },
];

function bandFor(cents: number): string {
  return BANDS.find((b) => cents >= b.min && cents < b.max)?.label ?? "10000+";
}

const SAFE_LABELS = new Set(SEED_LABELS.map((l) => l.name));

interface RawCell { month: string; direction: "in" | "out"; label: string; band: string; n: number; total: number }

export function buildAirlock(db: DbAdapter, config: AirlockConfig = { k: 5, timeGranularity: "month", amountMode: "band" }, now = Date.now()): AirlockManifest {
  const rows = db.all(
    `SELECT ${MONTH_EXPR} AS month, t.direction AS direction,
            COALESCE(l.name, 'Unlabelled') AS label, t.amount AS amount
       FROM tx_events t
       LEFT JOIN tx_labels tl ON tl.rowid = (SELECT x.rowid FROM tx_labels x WHERE x.tx_id = t.id
          ORDER BY (x.confirmed_at IS NOT NULL) DESC, x.confidence DESC LIMIT 1)
       LEFT JOIN labels l ON l.id = tl.label_id
      WHERE t.direction IN ('in','out')`,
  ) as Array<{ month: string; direction: "in" | "out"; label: string; amount: number }>;

  const cells = new Map<string, RawCell>();
  for (const r of rows) {
    const label = SAFE_LABELS.has(r.label) ? r.label : "Other";
    const band = config.amountMode === "sum" ? "all" : bandFor(Number(r.amount));
    const key = `${r.month}|${r.direction}|${label}|${band}`;
    const c = cells.get(key) ?? { month: r.month, direction: r.direction, label, band, n: 0, total: 0 };
    c.n += 1;
    c.total += Number(r.amount);
    cells.set(key, c);
  }

  // k-suppression: per month+direction, fold labels with fewer than k transactions into "Other".
  // Folding can leave an Other band below k (e.g. one July payment); those cells are dropped.
  // Nothing with n < k ever reaches the exported tables.
  const byMonthDir = new Map<string, RawCell[]>();
  for (const c of cells.values()) {
    const k = `${c.month}|${c.direction}`;
    byMonthDir.set(k, [...(byMonthDir.get(k) ?? []), c]);
  }
  const safe: RawCell[] = [];
  let suppressed = 0;
  for (const group of byMonthDir.values()) {
    const small = new Set(group.filter((c) => c.n < config.k).map((c) => c.label));
    if (small.size) suppressed += small.size;
    const merged = new Map<string, RawCell>();
    for (const c of group) {
      const label = small.has(c.label) && c.label !== "Other" ? "Other" : c.label;
      const key = `${c.month}|${c.direction}|${label}|${c.band}`;
      const cur = merged.get(key) ?? { ...c, label, n: 0, total: 0 };
      cur.n += c.n;
      cur.total += c.total;
      merged.set(key, cur);
    }
    for (const c of merged.values()) {
      if (c.n < config.k) { suppressed += 1; continue; }
      safe.push(c);
    }
  }

  db.exec("BEGIN; DELETE FROM airlock_monthly; DELETE FROM airlock_categories; DELETE FROM airlock_meta;");
  try {
    for (const c of safe) {
      db.run(
        `INSERT OR REPLACE INTO airlock_monthly (month, direction, label, amount_band, tx_count, total_cents) VALUES (?, ?, ?, ?, ?, ?)`,
        [c.month, c.direction, c.label, c.band, c.n, c.total],
      );
    }
    const cat = new Map<string, { month: string; label: string; total: number; n: number }>();
    for (const c of safe) {
      const key = `${c.month}|${c.label}`;
      const cur = cat.get(key) ?? { month: c.month, label: c.label, total: 0, n: 0 };
      cur.total += c.total;
      cur.n += c.n;
      cat.set(key, cur);
    }
    for (const c of cat.values()) {
      db.run(
        `INSERT OR REPLACE INTO airlock_categories (month, label, total_cents, tx_count) VALUES (?, ?, ?, ?)`,
        [c.month, c.label, c.total, c.n],
      );
    }
    const manifest: AirlockManifest = {
      builtAt: now, config,
      tables: [
        { name: "airlock_monthly", columns: ["month", "direction", "label", "amount_band", "tx_count", "total_cents"], rows: safe.length },
        { name: "airlock_categories", columns: ["month", "label", "total_cents", "tx_count"], rows: cat.size },
      ],
      suppressedCells: suppressed,
    };
    db.run(`INSERT INTO airlock_meta (key, value) VALUES ('manifest', ?)`, [JSON.stringify(manifest)]);
    db.exec("COMMIT;");
    return manifest;
  } catch (e) {
    db.exec("ROLLBACK;");
    throw e;
  }
}

export function getAirlockManifest(db: DbAdapter): AirlockManifest | null {
  const row = db.get(`SELECT value FROM airlock_meta WHERE key = 'manifest'`);
  if (!row) return null;
  try { return JSON.parse(row.value) as AirlockManifest; } catch { return null; }
}

/** JSON string for expo-sharing. Aggregates only; contains no counterparties or notes. */
export function exportAirlock(db: DbAdapter): string {
  const manifest = getAirlockManifest(db);
  const monthly = db.all(`SELECT month, direction, label, amount_band AS amountBand, tx_count AS txCount, total_cents AS totalCents FROM airlock_monthly ORDER BY month, direction, label, amount_band`);
  const categories = db.all(`SELECT month, label, total_cents AS totalCents, tx_count AS txCount FROM airlock_categories ORDER BY month, label`);
  return JSON.stringify({ manifest, monthly, categories }, null, 2);
}

export function airlockPreview(db: DbAdapter, limit = 8): Array<{ month: string; label: string; totalCents: number; txCount: number }> {
  return db.all(`SELECT month, label, total_cents AS totalCents, tx_count AS txCount FROM airlock_categories ORDER BY month DESC, total_cents DESC LIMIT ?`, [limit]);
}
