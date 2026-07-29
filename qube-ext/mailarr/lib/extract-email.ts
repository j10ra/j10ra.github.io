const DEAD_LOCALS = new Set([
  "accommodation",
  "accommodations",
  "admin",
  "careers",
  "compliance",
  "contact",
  "hello",
  "hr",
  "info",
  "jobs",
  "no-reply",
  "noreply",
  "privacy",
  "recruiting",
  "recruitment",
  "support",
  "talent",
]);

const APPLY_CONTEXT =
  /\b(apply|application|candidate|contact|cv|email|hiring|reach out|résumé|resume|send)\b/iu;
const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu;
const DEAD_LOCAL_PREFIX =
  /^(?:accommodations?|careers|hr|jobs|no-?reply|recruiting|recruitment|talent)(?:[+._-]|$)/iu;

export interface EmailCandidate {
  email: string;
  distance: number;
}

export function extractApplyEmail(text: string, proximity = 240): string | null {
  const candidates: EmailCandidate[] = [];

  for (const match of text.matchAll(EMAIL)) {
    const email = match[0];
    const local = email.slice(0, email.indexOf("@")).toLowerCase();

    if (DEAD_LOCALS.has(local) || DEAD_LOCAL_PREFIX.test(local)) continue;

    const index = match.index ?? 0;
    const from = Math.max(0, index - proximity);
    const to = Math.min(text.length, index + email.length + proximity);
    const context = text.slice(from, to);
    const contextMatches = [...context.matchAll(new RegExp(APPLY_CONTEXT.source, "giu"))];

    if (!contextMatches.length) continue;

    const localIndex = index - from;
    const distance = Math.min(
      ...contextMatches.map((entry) => Math.abs((entry.index ?? 0) - localIndex)),
    );

    candidates.push({ email, distance });
  }

  candidates.sort((left, right) => left.distance - right.distance);

  return candidates[0]?.email ?? null;
}
