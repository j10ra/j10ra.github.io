export function scoreText(
  text: string,
  rules: Record<string, number>,
): { score: number; matches: string[] } {
  const normalizedText = text.replace(/[\p{Pd}-]+/gu, " ");
  const matches: string[] = [];
  let score = 0;

  for (const [term, weight] of Object.entries(rules)) {
    const escaped = term
      .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      .replace(/\s+/g, "\\s+");
    const pattern = new RegExp(
      `(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`,
      "iu",
    );

    if (!pattern.test(normalizedText)) continue;

    matches.push(term);
    score += weight;
  }

  return { score, matches };
}
