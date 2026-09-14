import { normalizeSearchText } from "./text";

export type CatalogMotorcycle = { sku: string; brand: string; line: string };
export type MotorcycleMatch = {
  sku: string | null;
  canonicalName: string | null;
  confidence: number;
  method: "exact" | "alias" | "token_similarity" | "unresolved";
};

const BRAND_ALIASES: Record<string, string> = {
  hnda: "honda",
  bajai: "bajaj",
  suzuky: "suzuki",
  heroo: "hero",
  "a.k.t": "akt"
};

function canonicalize(value: string): string {
  let text = normalizeSearchText(value) ?? "";
  for (const [from, to] of Object.entries(BRAND_ALIASES)) {
    text = text.replace(new RegExp(`\\b${from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "g"), to);
  }
  return text.replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
}

function tokenScore(a: string, b: string): number {
  const A = new Set(a.split(" ").filter(Boolean));
  const B = new Set(b.split(" ").filter(Boolean));
  const intersection = [...A].filter((x) => B.has(x)).length;
  const union = new Set([...A, ...B]).size;
  return union ? intersection / union : 0;
}

export function matchMotorcycle(raw: string | null | undefined, catalog: CatalogMotorcycle[]): MotorcycleMatch {
  if (!raw?.trim()) return { sku: null, canonicalName: null, confidence: 0, method: "unresolved" };
  const needle = canonicalize(raw);
  const indexed = catalog.map((m) => ({ ...m, canonical: canonicalize(`${m.brand} ${m.line}`) }));
  const exact = indexed.find((m) => m.canonical === needle);
  if (exact) return { sku: exact.sku, canonicalName: `${exact.brand} ${exact.line}`, confidence: 1, method: "exact" };

  let best = indexed[0];
  let bestScore = 0;
  for (const candidate of indexed) {
    const score = tokenScore(needle, candidate.canonical);
    if (score > bestScore) { best = candidate; bestScore = score; }
  }
  if (best && bestScore >= 0.6) {
    return { sku: best.sku, canonicalName: `${best.brand} ${best.line}`, confidence: bestScore, method: "token_similarity" };
  }
  return { sku: null, canonicalName: null, confidence: bestScore, method: "unresolved" };
}
