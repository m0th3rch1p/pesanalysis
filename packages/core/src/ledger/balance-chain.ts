import type { BalanceChainStatus, Cents, ParsedSms } from "../types.js";

export interface ChainResult {
  ref: string | null;
  index: number;
  status: BalanceChainStatus;
  /** expected - stated balance in cents (non-zero only on "break") */
  discrepancy: Cents;
  /** True when this (balance-less Fuliza draw) message was audited before neighbours that precede it in input order. */
  reordered?: boolean;
}

export interface ChainOpts {
  /**
   * Fuliza draw notices carry no body time, so they take the SMS receive time (seconds) while the payment they
   * fund is stamped to the minute: the draw sorts AFTER the payment it funded (audit B4). A draw is tried at
   * earlier positions only among messages within this window before it. Default 5 minutes. 0 disables reordering.
   */
  drawReorderWindowMs?: number;
}

/** Kinds where the wallet-balance effect is deterministic from amount+fee. */
export function balanceEffect(p: ParsedSms): Cents | null {
  switch (p.kind) {
    case "send": case "paybill": case "till": case "withdraw": case "airtime": case "bundle":
      return -(p.amount + (p.fee ?? 0));
    case "receive": case "deposit": case "reversal":
      return p.amount - (p.fee ?? 0);
    case "loan_draw":
      return p.provider === "mpesa" ? p.amount : null; // Fuliza-style overdraft credits the wallet; the message states no balance
    case "loan_repay":
      return -(p.amount + (p.fee ?? 0)); // Fuliza/Okoa repayment debits the wallet
    case "fee":
      return -p.amount;
    case "bank_debit":
      return -(p.amount + (p.fee ?? 0));
    case "bank_credit":
      return p.amount - (p.fee ?? 0);
    default:
      return null;
  }
}

/**
 * Balance-chain audit. Every M-Pesa transaction message states the post-transaction balance, so
 * consecutive stated balances must satisfy: prev_stated + sum(effects since) == stated.
 * Balance-less messages (Fuliza draws, Okoa loans) between stated ones ACCUMULATE a pending effect
 * (a Fuliza draw is real money in the wallet). A break = missing message, forged message (sender
 * spoofing), or activity from another channel. It is a SIGNAL for review, never proof.
 * Input MUST be one provider's messages, time-ordered. Results are returned in INPUT order.
 *
 * Fuliza ordering: a balance-less mpesa draw is moved earlier (within `drawReorderWindowMs`) ONLY if the
 * move strictly reduces the number of breaks (ties: total absolute discrepancy). If no placement
 * reconciles anything, the original order and its breaks stand, so a genuinely missing message is not hidden.
 */
export function auditBalanceChain(txs: ParsedSms[], opts: ChainOpts = {}): ChainResult[] {
  const windowMs = opts.drawReorderWindowMs ?? 300_000;
  const order = txs.map((_, i) => i);
  const run = (ord: number[]) => runChain(ord.map((i) => txs[i]!));
  const score = (r: ChainResult[]): [number, number] =>
    [r.filter((x) => x.status === "break").length, r.reduce((a, x) => a + Math.abs(x.discrepancy), 0)];
  const better = (a: [number, number], b: [number, number]) => a[0] < b[0] || (a[0] === b[0] && a[1] < b[1]);

  let res = run(order);
  const tried = new Set<number>();
  const reorderedSet = new Set<number>();
  if (windowMs > 0) {
    for (let guard = 0; guard < txs.length; guard++) {
      let pos = -1;
      // next unprocessed balance-less draw that sits next to a break
      for (let p = 0; p < order.length; p++) {
        const orig = order[p]!;
        if (tried.has(orig) || !isChainDraw(txs[orig]!)) continue;
        if (res.slice(Math.max(0, p - 1), p + 3).some((x) => x.status === "break")) { pos = p; break; }
      }
      if (pos < 0) break;
      const orig = order[pos]!;
      tried.add(orig); // each draw is tried once
      const draw = txs[orig]!;
      let best: { ord: number[]; r: ChainResult[]; s: [number, number] } | null = null;
      const cur = score(res);
      for (let k = pos - 1; k >= 0; k--) {
        const nb = txs[order[k]!]!;
        if (draw.occurredAt - nb.occurredAt > windowMs && nb.ref !== draw.ref) break;
        const cand = order.slice(); cand.splice(pos, 1); cand.splice(k, 0, orig);
        const r = run(cand); const s2 = score(r);
        if (better(s2, best ? best.s : cur)) best = { ord: cand, r, s: s2 };
      }
      if (best) { order.splice(0, order.length, ...best.ord); res = best.r; reorderedSet.add(orig); }
    }
  }
  const out: ChainResult[] = new Array(txs.length);
  res.forEach((r, p) => {
    const orig = order[p]!;
    const reordered = reorderedSet.has(orig);
    out[orig] = { ...r, index: orig, ...(reordered ? { reordered: true } : {}) };
  });
  return out;
}

function isChainDraw(p: ParsedSms): boolean {
  return p.kind === "loan_draw" && p.balanceAfter == null && balanceEffect(p) != null;
}

function runChain(txs: ParsedSms[]): ChainResult[] {
  const out: ChainResult[] = [];
  let anchor: Cents | null = null;
  let pending: Cents = 0; // effects of balance-less txs since the last stated balance
  txs.forEach((p, index) => {
    const eff = balanceEffect(p);
    if (p.balanceAfter == null) {
      if (eff != null) pending += eff;
      out.push({ ref: p.ref, index, status: "unknown", discrepancy: 0 });
      return;
    }
    if (anchor == null) {
      out.push({ ref: p.ref, index, status: "first", discrepancy: 0 });
    } else if (eff == null) {
      out.push({ ref: p.ref, index, status: "unknown", discrepancy: 0 });
      pending = 0; // state-dependent event re-anchors the chain conservatively
    } else {
      const expected = anchor + pending + eff;
      const d = expected - p.balanceAfter;
      out.push({ ref: p.ref, index, status: d === 0 ? "ok" : "break", discrepancy: d });
      pending = 0;
    }
    anchor = p.balanceAfter;
    pending = 0;
  });
  return out;
}
