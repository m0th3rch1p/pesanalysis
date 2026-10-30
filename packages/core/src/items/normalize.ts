/** Item-name normalisation shared by the note parser, inference and rollups. */
const SINGULAR: Record<string, string> = {
  cigarettes: "cigarette", eggs: "egg", tomatoes: "tomato", potatoes: "potato", onions: "onion",
  bananas: "banana", oranges: "orange", mangoes: "mango", sodas: "soda", chapatis: "chapo",
  mandazis: "mandazi", smokies: "smokie", sausages: "sausage", carrots: "carrot", cabbages: "cabbage",
  apples: "apple", avocados: "avocado", lemons: "lemon", samosas: "samosa", bhajias: "bhajia",
};

export function normalizeItemName(raw: string): string {
  const s = raw.normalize("NFKC").toLowerCase().replace(/[^a-z0-9 /]+/g, " ").replace(/\s+/g, " ").trim();
  return s.split(" ").map((w) => SINGULAR[w] ?? w).join(" ");
}

export function displayItemName(raw: string): string {
  return raw.normalize("NFKC").replace(/\s+/g, " ").trim().slice(0, 80);
}
