const DEFAULT_RULES: Record<string, number> = {
  senior: 2,
  react: 3,
  typescript: 3,
  "full stack": 3,
  fullstack: 3,
  ai: 2,
  agent: 2,
  agentic: 2,
  mcp: 3,
  "model context protocol": 3,
  expo: 1,
  ui: 1,
};

export const DEFAULT_SCORE_FLOOR = 3;

export function scoreText(
  text: string,
  rules: Record<string, number> = DEFAULT_RULES,
): { score: number; matches: string[] } {
  const matches: string[] = [];
  let score = 0;

  for (const [term, weight] of Object.entries(rules)) {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
    const pattern = new RegExp(
      `(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`,
      "iu",
    );

    if (!pattern.test(text)) continue;

    matches.push(term);
    score += weight;
  }

  return { score, matches };
}
