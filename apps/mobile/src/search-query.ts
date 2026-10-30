import type { ParsedSearch } from "@yako/core";

/** Rebuild the search bar text after a chip is removed. */
export function removeChip(p: ParsedSearch, chipId: string): ParsedSearch {
  const filters = { ...(p.filters ?? {}) };
  let fts = p.fts;
  if (chipId.startsWith("tag-")) filters.tags = (filters.tags ?? []).filter((t) => `tag-${t}` !== chipId);
  else if (chipId.startsWith("venture-")) filters.ventures = (filters.ventures ?? []).filter((v) => `venture-${v}` !== chipId);
  else if (chipId.startsWith("cat-")) filters.labels = (filters.labels ?? []).filter((l) => `cat-${l}` !== chipId);
  else if (chipId.startsWith("from-")) filters.counterparties = (filters.counterparties ?? []).filter((c) => `from-${c}` !== chipId);
  else if (chipId.startsWith("place-")) delete filters.place;
  else if (chipId === "amount" || chipId === "amount-min") delete filters.minAmountCents;
  else if (chipId === "amount" || chipId === "amount-max") delete filters.maxAmountCents;
  else if (chipId === "time" || chipId === "after" || chipId === "before") delete filters.time;
  else if (chipId === "dir") delete filters.direction;
  else if (chipId === "text") fts = "";
  if (filters.tags?.length === 0) delete filters.tags;
  if (filters.ventures?.length === 0) delete filters.ventures;
  if (filters.labels?.length === 0) delete filters.labels;
  if (filters.counterparties?.length === 0) delete filters.counterparties;
  return { filters, fts, chips: p.chips.filter((c) => c.id !== chipId) };
}

export function serializeSearch(p: ParsedSearch): string {
  const f = p.filters;
  const bits: string[] = [];
  for (const t of f.tags ?? []) bits.push(`tag:"${t}"`);
  for (const v of f.ventures ?? []) bits.push(`venture:"${v}"`);
  for (const l of f.labels ?? []) bits.push(`cat:"${l}"`);
  for (const c of f.counterparties ?? []) bits.push(`from:"${c}"`);
  if (f.place) bits.push(`@${f.place}`);
  if (f.minAmountCents != null && f.maxAmountCents != null) bits.push(`${Math.round(f.minAmountCents / 100)}..${Math.round(f.maxAmountCents / 100)}`);
  else {
    if (f.minAmountCents != null) bits.push(`over ${Math.round(f.minAmountCents / 100)}`);
    if (f.maxAmountCents != null) bits.push(`under ${Math.round(f.maxAmountCents / 100)}`);
  }
  if (f.direction === "out") bits.push("out");
  if (f.direction === "in") bits.push("in");
  if (f.time?.kind === "named") bits.push(f.time.name.replace(/_/g, " "));
  else if (f.time?.kind === "relative") bits.push(`last ${f.time.n} ${f.time.unit}s`);
  if (p.fts) bits.push(p.fts);
  return bits.join(" ");
}
