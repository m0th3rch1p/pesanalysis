/**
 * Zone-aware tool registry (D39). Invariants enforced at registration AND invocation:
 *  - a tool is never both read_private and send_out;
 *  - read_private tools are never callable from Z2;
 *  - send_out tools require Z2 + an explicit user tap;
 *  - every call is audited locally with a row count.
 */
import type { DbAdapter } from "../db/migrate.js";
import { executePlan, type AskContext } from "../analyst/ask.js";
import { validatePlan, type QueryPlan } from "../analyst/plan.js";
import { listTags } from "../tags/store.js";
import { factsFor } from "../profile/store.js";
import { exportAirlock, getAirlockManifest } from "../airlock/build.js";
import type { ToolSpec, Zone } from "./types.js";

const RANK: Record<Zone, number> = { Z0: 0, Z1: 1, Z2: 2 };

export class ZoneViolation extends Error {
  constructor(message: string) { super(message); this.name = "ZoneViolation"; }
}

export interface RegistryContext { db: DbAdapter; now?: () => number }
export interface InvokeOptions { hostId?: string; confirmed?: boolean }

export interface Registry {
  registerTool(spec: ToolSpec): void;
  toolsForZone(zone: Zone): ToolSpec[];
  invokeTool(zone: Zone, name: string, args: Record<string, unknown>, opts?: InvokeOptions): unknown;
  specs(): ToolSpec[];
}

export function createRegistry(ctx: RegistryContext): Registry {
  const tools = new Map<string, ToolSpec>();

  const registerTool = (spec: ToolSpec) => {
    if (!spec.name.trim()) throw new ZoneViolation("tool name is required");
    if (tools.has(spec.name)) throw new ZoneViolation(`duplicate tool ${spec.name}`);
    if (!spec.allowedZones.length) throw new ZoneViolation(`${spec.name}: no allowed zones`);
    if (spec.capability === "read_private" && spec.allowedZones.includes("Z2")) throw new ZoneViolation(`${spec.name}: read_private may not be callable from Z2`);
    if (spec.capability === "send_out") {
      if (spec.confirm !== "user_tap") throw new ZoneViolation(`${spec.name}: send_out requires confirm=user_tap`);
      if (spec.allowedZones.some((z) => z !== "Z2")) throw new ZoneViolation(`${spec.name}: send_out is Z2 only`);
    }
    if (spec.rowPolicy.maxRows < 1 || spec.rowPolicy.maxRows > 10_000) throw new ZoneViolation(`${spec.name}: maxRows out of range`);
    tools.set(spec.name, spec);
  };

  const toolsForZone = (zone: Zone) => [...tools.values()]
    .filter((t) => t.allowedZones.includes(zone))
    .map((t) => ({
      ...t,
      rowPolicy: { ...t.rowPolicy, allowedColumns: { [zone]: t.rowPolicy.allowedColumns[zone] ?? [] } },
    }));

  const invokeTool = (zone: Zone, name: string, args: Record<string, unknown>, opts: InvokeOptions = {}) => {
    const tool = tools.get(name);
    if (!tool) throw new ZoneViolation(`unknown tool ${name}`);
    if (!tool.allowedZones.includes(zone)) throw new ZoneViolation(`${name} is not available in ${zone}`);
    if (tool.capability === "send_out" && opts.confirmed !== true) throw new ZoneViolation(`${name} requires an explicit user tap`);
    const now = ctx.now?.() ?? Date.now();
    let result: unknown;
    let ok = true;
    try {
      result = runBuiltin(ctx, name, args, now);
    } catch (e) {
      ok = false;
      audit(ctx.db, zone, name, args, 0, now, false, opts.hostId);
      throw e;
    }
    const rows = rowCount(result);
    if (rows > tool.rowPolicy.maxRows) {
      audit(ctx.db, zone, name, args, rows, now, false, opts.hostId);
      throw new ZoneViolation(`${name} returned ${rows} rows > maxRows ${tool.rowPolicy.maxRows}`);
    }
    audit(ctx.db, zone, name, args, rows, now, ok, opts.hostId);
    return result;
  };

  return { registerTool, toolsForZone, invokeTool, specs: () => [...tools.values()] };
}

function audit(db: DbAdapter, zone: Zone, tool: string, args: Record<string, unknown>, rowCount: number, now: number, ok: boolean, hostId?: string): void {
  db.run(
    `INSERT INTO tool_audit (zone, host_id, tool, params_json, row_count, ok, at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [zone, hostId ?? null, tool, JSON.stringify(args).slice(0, 2000), rowCount, ok ? 1 : 0, now],
  );
}

function rowCount(v: unknown): number {
  if (Array.isArray(v)) return v.length;
  if (v && typeof v === "object") {
    const obj = v as Record<string, unknown>;
    if (Array.isArray(obj.rows)) return obj.rows.length;
    if (typeof obj.count === "number") return obj.count;
  }
  return 1;
}

function runBuiltin(ctx: RegistryContext, name: string, args: Record<string, unknown>, now: number): unknown {
  switch (name) {
    case "ledger_summary": {
      const from = Number(args.fromMs ?? 0);
      const to = Number(args.toMs ?? now);
      if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) throw new Error("invalid range");
      const row = ctx.db.get(
        `SELECT COUNT(*) AS n,
                COALESCE(SUM(CASE WHEN direction = 'in' AND COALESCE(flow_class,'') <> 'debt_draw' THEN amount ELSE 0 END),0) AS inCents,
                COALESCE(SUM(CASE WHEN direction = 'out' AND COALESCE(flow_class,'') <> 'debt_repay' THEN amount ELSE 0 END),0) AS outCents,
                COALESCE(SUM(COALESCE(fee,0)),0) AS feesCents
           FROM tx_events WHERE occurred_at >= ? AND occurred_at < ?`,
        [from, to],
      );
      return { count: 1, rows: [{ txCount: Number(row?.n ?? 0), inCents: Number(row?.inCents ?? 0), outCents: Number(row?.outCents ?? 0), feesCents: Number(row?.feesCents ?? 0) }] };
    }
    case "plan_query": {
      const v = validatePlan(args.plan);
      if (!v.ok) throw new Error(`invalid plan: ${v.errors.join("; ")}`);
      const ex = executePlan(ctx.db, v.plan as QueryPlan, now);
      return { rows: ex.rows, range: ex.range.label, provenance: v.plan.measure };
    }
    case "ledger_list": {
      const from = Number(args.fromMs ?? 0);
      const to = Number(args.toMs ?? now);
      const limit = Math.min(Number(args.limit ?? 100), 500);
      return {
        rows: ctx.db.all(
          `SELECT t.id, t.occurred_at AS occurredAt, t.amount, t.fee, t.direction, t.kind, t.status,
                  COALESCE(c.display_name, json_extract(c.raw_names, '$[0]')) AS counterparty
             FROM tx_events t LEFT JOIN counterparties c ON c.id = t.counterparty_id
            WHERE t.occurred_at >= ? AND t.occurred_at < ? ORDER BY t.occurred_at DESC LIMIT ?`,
          [from, to, limit],
        ),
      };
    }
    case "tags_summary":
      return { rows: listTags(ctx.db).map((t) => ({ name: t.name, kind: t.kind, txCount: t.txCount, totalCents: t.totalCents })) };
    case "facts_summary":
      return { rows: factsFor(ctx.db).map((f) => ({ subject: f.subject, predicate: f.predicate, object: f.object })) };
    case "airlock_manifest":
      return { manifest: getAirlockManifest(ctx.db) };
    case "airlock_release":
      return { payload: exportAirlock(ctx.db), manifest: getAirlockManifest(ctx.db) };
    default:
      throw new Error(`no implementation for ${name}`);
  }
}

/** Built-ins installed into the demo registry. Keep column lists honest with the SQL above. */
export const BUILTIN_TOOLS: ToolSpec[] = [
  {
    name: "ledger_summary", description: "Aggregate in/out/fees for a time range. No messages, notes or counterparties.",
    parameters: { type: "object", required: ["fromMs", "toMs"], properties: { fromMs: { type: "integer" }, toMs: { type: "integer" } } },
    returns: { type: "object" }, allowedZones: ["Z0"], capability: "read_private", confirm: "none",
    rowPolicy: { maxRows: 1, allowedColumns: { Z0: ["txCount", "inCents", "outCents", "feesCents"] } },
  },
  {
    name: "plan_query", description: "Run a validated QueryPlan and return grouped aggregates.",
    parameters: { type: "object", required: ["plan"], properties: { plan: { type: "object" } } },
    returns: { type: "object" }, allowedZones: ["Z0", "Z1"], capability: "read_private", confirm: "none",
    rowPolicy: { maxRows: 100, allowedColumns: { Z0: ["k0", "k1", "v"], Z1: ["k0", "k1", "v"] } },
  },
  {
    name: "ledger_list", description: "List transactions with counterparty and amount. Z0 only; never SMS bodies.",
    parameters: { type: "object", properties: { fromMs: { type: "integer" }, toMs: { type: "integer" }, limit: { type: "integer" } } },
    returns: { type: "object" }, allowedZones: ["Z0"], capability: "read_private", confirm: "none",
    rowPolicy: { maxRows: 500, allowedColumns: { Z0: ["occurredAt", "amount", "fee", "direction", "kind", "status", "counterparty"] } },
  },
  {
    name: "tags_summary", description: "Tag and venture totals. No transaction text.",
    parameters: { type: "object", properties: {} }, returns: { type: "object" },
    allowedZones: ["Z0", "Z1"], capability: "read_private", confirm: "none",
    rowPolicy: { maxRows: 500, allowedColumns: { Z0: ["name", "kind", "txCount", "totalCents"], Z1: ["name", "kind", "txCount", "totalCents"] } },
  },
  {
    name: "facts_summary", description: "Confirmed world-model facts (roles, occupations, venture names).",
    parameters: { type: "object", properties: {} }, returns: { type: "object" },
    allowedZones: ["Z0", "Z1"], capability: "read_private", confirm: "none",
    rowPolicy: { maxRows: 500, allowedColumns: { Z0: ["subject", "predicate", "object"], Z1: ["subject", "predicate", "object"] } },
  },
  {
    name: "airlock_manifest", description: "What the airlock currently contains (metadata only).",
    parameters: { type: "object", properties: {} }, returns: { type: "object" },
    allowedZones: ["Z0", "Z2"], capability: "pure", confirm: "none",
    rowPolicy: { maxRows: 10, allowedColumns: { Z0: ["manifest"], Z2: ["manifest"] } },
  },
  {
    name: "airlock_release", description: "User-tapped export of k-suppressed monthly aggregates. The only Z2 egress.",
    parameters: { type: "object", properties: {} }, returns: { type: "object" },
    allowedZones: ["Z2"], capability: "send_out", confirm: "user_tap",
    rowPolicy: { maxRows: 2000, allowedColumns: { Z2: ["month", "direction", "label", "amountBand", "txCount", "totalCents"] }, suppressBelowK: 5 },
  },
];

export function installBuiltins(registry: Registry): Registry {
  for (const t of BUILTIN_TOOLS) registry.registerTool(t);
  return registry;
}
