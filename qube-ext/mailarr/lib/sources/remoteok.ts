import type { NormalizedPosting } from "../model.js";
import { asArray, asRecord, fetchJson, stripHtml, textField } from "./utils.js";

const URL = "https://remoteok.com/api";

export function parseRemoteOk(payload: unknown): NormalizedPosting[] {
  return asArray(payload)
    .map(asRecord)
    .filter((entry) => "id" in entry && "position" in entry)
    .map((entry) => ({
      company: textField(entry, "company").trim(),
      role: textField(entry, "position").trim(),
      rateInfo: salary(entry),
      source: "RemoteOK",
      url: textField(entry, "url") || textField(entry, "apply_url"),
      description: stripHtml(textField(entry, "description")),
      publishedAt: textField(entry, "date") || null,
      payload: entry,
    }))
    .filter((posting) => posting.company && posting.role && posting.url);
}

export async function fetchRemoteOk(): Promise<NormalizedPosting[]> {
  return parseRemoteOk(await fetchJson(URL));
}

function salary(entry: Record<string, unknown>): string {
  const minimum = Number(entry.salary_min ?? 0);
  const maximum = Number(entry.salary_max ?? 0);

  if (!minimum && !maximum) return "";
  if (minimum && maximum) return `$${minimum} - $${maximum}`;

  return `$${minimum || maximum}`;
}
