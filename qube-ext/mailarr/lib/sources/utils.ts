import type { NormalizedPosting } from "../model.js";

export async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url, {
    headers: { "user-agent": "Mailarr/0.1 (+https://github.com/j10ra/j10ra.github.io)" },
  });

  if (!response.ok) throw new Error(`HTTP ${response.status} from ${url}`);

  return response.json();
}

export async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: { "user-agent": "Mailarr/0.1 (+https://github.com/j10ra/j10ra.github.io)" },
  });

  if (!response.ok) throw new Error(`HTTP ${response.status} from ${url}`);

  return response.text();
}

export function decodeHtml(value: string): string {
  const named: Record<string, string> = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    nbsp: " ",
    quot: '"',
  };

  return value.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/giu, (entity, key: string) => {
    if (key.startsWith("#x")) return String.fromCodePoint(Number.parseInt(key.slice(2), 16));
    if (key.startsWith("#")) return String.fromCodePoint(Number.parseInt(key.slice(1), 10));

    return named[key.toLowerCase()] ?? entity;
  });
}

export function stripHtml(value: string): string {
  return decodeHtml(
    value
      .replace(/<br\s*\/?>/giu, "\n")
      .replace(/<\/p>/giu, "\n")
      .replace(/<[^>]+>/gu, " "),
  )
    .replace(/\s+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

export function extractRateInfo(text: string): string {
  const match = text.match(
    /(?:[$€£]\s?\d[\d,.]*(?:\s?[kKmM])?(?:\s*(?:-|–|to)\s*[$€£]?\s?\d[\d,.]*(?:\s?[kKmM])?)?(?:\s*(?:\/|per)\s*(?:hour|hr|year|annum|week))?)/u,
  );

  return match?.[0] ?? "";
}

export function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected an object payload");
  }

  return value as Record<string, unknown>;
}

export function asArray(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error("Expected an array payload");

  return value;
}

export function textField(record: Record<string, unknown>, field: string): string {
  const value = record[field];

  return typeof value === "string" ? value : value == null ? "" : String(value);
}

export type PostingParser = (payload: unknown) => NormalizedPosting[];
