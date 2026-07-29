const BLOCKED_LOCALS = new Set([
  "admin",
  "compliance",
  "no-reply",
  "noreply",
  "privacy",
  "security",
  "support",
]);
const EMAIL = /^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/iu;
const BLOCKED_PREFIX = /^(?:no-?reply|privacy|security|support)(?:[+._-]|$)/iu;

export function filterContactEmail(value: string): string | null {
  const email = value.trim();

  if (!EMAIL.test(email)) return null;

  const local = email.slice(0, email.indexOf("@")).toLowerCase();

  return BLOCKED_LOCALS.has(local) || BLOCKED_PREFIX.test(local) ? null : email;
}
