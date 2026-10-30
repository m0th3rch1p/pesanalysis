/**
 * Things: a local product/warranty registry attached to a payment photo.
 * Visual matching is a 64-bit dHash (Hamming distance) computed on the phone.
 * No image or hash is uploaded.
 */
import { lastInsertId, type DbAdapter } from "../db/migrate.js";

export interface Product {
  id: number; txId: number | null; attachmentId: number | null;
  name: string; brand: string | null; model: string | null;
  boughtAt: number | null; priceCents: number | null;
  warrantyMonths: number | null; warrantyEndsAt: number | null;
  imageHash: string | null; status: string; notes: string | null;
  createdAt: number; updatedAt: number; uri: string | null;
}

export interface ProductInput {
  txId?: number | null; attachmentId?: number | null;
  name: string; brand?: string | null; model?: string | null;
  boughtAt?: number | null; priceCents?: number | null;
  warrantyMonths?: number | null; imageHash?: string | null; notes?: string | null;
}

function endOfWarranty(boughtAt: number | null, months: number | null): number | null {
  if (boughtAt == null || months == null || months <= 0) return null;
  const d = new Date(boughtAt);
  d.setMonth(d.getMonth() + months);
  return d.getTime();
}

export function createProduct(db: DbAdapter, input: ProductInput, now = Date.now()): number {
  const name = input.name.trim().slice(0, 80);
  if (!name) throw new Error("product name is empty");
  const hash = input.imageHash?.trim().toLowerCase() ?? null;
  if (hash && !/^[0-9a-f]{16}$/.test(hash)) throw new Error("image hash must be 16 hex chars");
  const months = input.warrantyMonths == null ? null : Math.max(0, Math.min(120, Math.floor(input.warrantyMonths)));
  const r = db.run(
    `INSERT INTO products
      (tx_id, attachment_id, name, brand, model, bought_at, price_cents, warranty_months,
       warranty_ends_at, image_hash, notes, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      input.txId ?? null, input.attachmentId ?? null, name, input.brand?.trim().slice(0, 60) || null,
      input.model?.trim().slice(0, 60) || null, input.boughtAt ?? null, input.priceCents ?? null,
      months, endOfWarranty(input.boughtAt ?? null, months), hash, input.notes?.trim().slice(0, 300) || null,
      now, now,
    ],
  );
  return lastInsertId(r);
}

export function listProducts(db: DbAdapter, includeRetired = false): Product[] {
  return db.all(
    `SELECT p.id, p.tx_id AS txId, p.attachment_id AS attachmentId, p.name, p.brand, p.model,
            p.bought_at AS boughtAt, p.price_cents AS priceCents, p.warranty_months AS warrantyMonths,
            p.warranty_ends_at AS warrantyEndsAt, p.image_hash AS imageHash, p.status, p.notes,
            p.created_at AS createdAt, p.updated_at AS updatedAt, a.uri
       FROM products p LEFT JOIN attachments a ON a.id = p.attachment_id
      ${includeRetired ? "" : "WHERE p.status = 'active'"}
      ORDER BY COALESCE(p.bought_at, p.created_at) DESC, p.id DESC`,
  ).map((r: Record<string, unknown>) => ({
    ...r,
    id: Number(r.id), txId: r.txId == null ? null : Number(r.txId), attachmentId: r.attachmentId == null ? null : Number(r.attachmentId),
    boughtAt: r.boughtAt == null ? null : Number(r.boughtAt), priceCents: r.priceCents == null ? null : Number(r.priceCents),
    warrantyMonths: r.warrantyMonths == null ? null : Number(r.warrantyMonths), warrantyEndsAt: r.warrantyEndsAt == null ? null : Number(r.warrantyEndsAt),
    imageHash: r.imageHash == null ? null : String(r.imageHash), status: String(r.status), createdAt: Number(r.createdAt), updatedAt: Number(r.updatedAt),
    uri: r.uri == null ? null : String(r.uri), name: String(r.name), brand: r.brand == null ? null : String(r.brand),
    model: r.model == null ? null : String(r.model), notes: r.notes == null ? null : String(r.notes),
  })) as Product[];
}

export function deleteProduct(db: DbAdapter, id: number): void {
  db.run(`DELETE FROM products WHERE id = ?`, [id]);
}

export function setProductStatus(db: DbAdapter, id: number, status: "active" | "retired", now = Date.now()): void {
  db.run(`UPDATE products SET status = ?, updated_at = ? WHERE id = ?`, [status, now, id]);
}

export function hammingHex(a: string, b: string): number {
  const x = BigInt(`0x${a}`), y = BigInt(`0x${b}`);
  let z = x ^ y, n = 0;
  while (z) { n += Number(z & 1n); z >>= 1n; }
  return n;
}

/** Local "reverse image search": nearest perceptual hashes within a small distance. */
export function matchProducts(db: DbAdapter, hash: string, maxDistance = 10): Array<{ product: Product; distance: number }> {
  if (!/^[0-9a-f]{16}$/.test(hash)) return [];
  return listProducts(db, true)
    .filter((p) => p.imageHash)
    .map((p) => ({ product: p, distance: hammingHex(hash, p.imageHash!) }))
    .filter((x) => x.distance <= maxDistance)
    .sort((a, b) => a.distance - b.distance)
    .slice(0, 5);
}

export interface WarrantyInfo { endAt: number | null; daysLeft: number | null; state: "none" | "active" | "expiring" | "expired" }
export function warrantyInfo(p: Product, now = Date.now()): WarrantyInfo {
  if (p.warrantyEndsAt == null) return { endAt: null, daysLeft: null, state: "none" };
  const daysLeft = Math.ceil((p.warrantyEndsAt - now) / 86_400_000);
  return { endAt: p.warrantyEndsAt, daysLeft, state: daysLeft < 0 ? "expired" : daysLeft <= 30 ? "expiring" : "active" };
}

export interface BrandLife { brand: string; count: number; active: number; avgOwnedDays: number; oldestDays: number }
export function brandLifespans(db: DbAdapter, now = Date.now()): BrandLife[] {
  const rows = listProducts(db, true);
  const map = new Map<string, { count: number; active: number; days: number[]; oldest: number }>();
  for (const p of rows) {
    const brand = p.brand?.trim();
    if (!brand) continue;
    const start = p.boughtAt ?? p.createdAt;
    const end = p.status === "retired" ? p.updatedAt : now;
    const days = Math.max(0, Math.round((end - start) / 86_400_000));
    const cur = map.get(brand) ?? { count: 0, active: 0, days: [], oldest: 0 };
    cur.count++; if (p.status === "active") cur.active++;
    cur.days.push(days); cur.oldest = Math.max(cur.oldest, days);
    map.set(brand, cur);
  }
  return [...map.entries()].map(([brand, v]) => ({
    brand, count: v.count, active: v.active,
    avgOwnedDays: v.days.length ? Math.round(v.days.reduce((s, d) => s + d, 0) / v.days.length) : 0,
    oldestDays: v.oldest,
  })).sort((a, b) => b.count - a.count || b.avgOwnedDays - a.avgOwnedDays);
}
