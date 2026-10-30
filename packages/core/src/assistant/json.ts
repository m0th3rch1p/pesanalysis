/** Strict JSON helpers for untrusted input (model output, pasted packs). Pure, no I/O. */

export class StrictJsonError extends Error {
  constructor(public readonly code: string) { super(code); this.name = "StrictJsonError"; }
}

export interface StrictJsonLimits { maxBytes: number; maxDepth: number; maxNodes: number }
export const DEFAULT_JSON_LIMITS: StrictJsonLimits = { maxBytes: 32_768, maxDepth: 6, maxNodes: 2_000 };

const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/**
 * Recursive-descent JSON parser that, unlike JSON.parse, rejects duplicate keys, `__proto__` /
 * `constructor` / `prototype` keys, excessive depth and node counts, and
 * returns null-prototype objects. Throws StrictJsonError(code).
 */
export function strictParseJson(text: string, limits: StrictJsonLimits = DEFAULT_JSON_LIMITS): unknown {
  if (typeof text !== "string") throw new StrictJsonError("not_a_string");
  if (utf8Length(text) > limits.maxBytes) throw new StrictJsonError("too_large");
  let i = 0;
  let nodes = 0;
  const ws = () => { while (i < text.length && (text[i] === " " || text[i] === "\n" || text[i] === "\r" || text[i] === "\t")) i++; };
  const bump = () => { if (++nodes > limits.maxNodes) throw new StrictJsonError("too_many_nodes"); };

  function value(depth: number): unknown {
    if (depth > limits.maxDepth) throw new StrictJsonError("too_deep");
    ws();
    const c = text[i];
    bump();
    if (c === "{") {
      i++;
      const obj: Record<string, unknown> = Object.create(null);
      ws();
      if (text[i] === "}") { i++; return obj; }
      for (;;) {
        ws();
        if (text[i] !== '"') throw new StrictJsonError("bad_key");
        const k = str();
        if (FORBIDDEN_KEYS.has(k)) throw new StrictJsonError(`forbidden_key:${k}`);
        if (k in obj) throw new StrictJsonError(`duplicate_key:${k}`);
        ws();
        if (text[i++] !== ":") throw new StrictJsonError("expected_colon");
        obj[k] = value(depth + 1);
        ws();
        const d = text[i++];
        if (d === ",") continue;
        if (d === "}") return obj;
        throw new StrictJsonError("expected_comma_or_brace");
      }
    }
    if (c === "[") {
      i++;
      const arr: unknown[] = [];
      ws();
      if (text[i] === "]") { i++; return arr; }
      for (;;) {
        arr.push(value(depth + 1));
        ws();
        const d = text[i++];
        if (d === ",") continue;
        if (d === "]") return arr;
        throw new StrictJsonError("expected_comma_or_bracket");
      }
    }
    if (c === '"') return str();
    if (text.startsWith("true", i)) { i += 4; return true; }
    if (text.startsWith("false", i)) { i += 5; return false; }
    if (text.startsWith("null", i)) { i += 4; return null; }
    const m = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(i, i + 40));
    if (!m) throw new StrictJsonError("bad_value");
    i += m[0].length;
    const n = Number(m[0]);
    if (!Number.isFinite(n)) throw new StrictJsonError("bad_number");
    return n;
  }

  function str(): string {
    i++; // opening quote
    let out = "";
    for (;;) {
      if (i >= text.length) throw new StrictJsonError("unterminated_string");
      const ch = text[i++]!;
      if (ch === '"') return out;
      const code = ch.charCodeAt(0);
      if (code < 0x20) throw new StrictJsonError("control_char_in_string");
      if (ch !== "\\") { out += ch; continue; }
      const e = text[i++];
      switch (e) {
        case '"': out += '"'; break;
        case "\\": out += "\\"; break;
        case "/": out += "/"; break;
        case "b": out += "\b"; break;
        case "f": out += "\f"; break;
        case "n": out += "\n"; break;
        case "r": out += "\r"; break;
        case "t": out += "\t"; break;
        case "u": {
          const hex = text.slice(i, i + 4);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new StrictJsonError("bad_unicode_escape");
          out += String.fromCharCode(parseInt(hex, 16));
          i += 4;
          break;
        }
        default: throw new StrictJsonError("bad_escape");
      }
    }
  }

  const v = value(0);
  ws();
  if (i !== text.length) throw new StrictJsonError("trailing_data");
  return v;
}

function utf8Length(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff) { n += 4; i++; }
    else n += 3;
  }
  return n;
}
export { utf8Length };

/** Deterministic JSON: sorted keys, no whitespace. Input must be plain JSON data. */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).sort().filter((k) => o[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(",")}}`;
}
