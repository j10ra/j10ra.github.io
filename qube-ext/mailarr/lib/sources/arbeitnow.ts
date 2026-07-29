import type { NormalizedPosting } from "../model.js";
import { asArray, asRecord, extractRateInfo, fetchJson, stripHtml, textField } from "./utils.js";

const URL = "https://www.arbeitnow.com/api/job-board-api";

export function parseArbeitnow(payload: unknown): NormalizedPosting[] {
  const root = asRecord(payload);

  return asArray(root.data)
    .map(asRecord)
    .map((job) => {
      const description = stripHtml(textField(job, "description"));

      return {
        company: textField(job, "company_name").trim(),
        role: textField(job, "title").trim(),
        rateInfo: extractRateInfo(description),
        source: "Arbeitnow",
        url: textField(job, "url"),
        description,
        publishedAt: epochDate(job.created_at),
        payload: job,
      };
    })
    .filter((posting) => posting.company && posting.role && posting.url);
}

export async function fetchArbeitnow(): Promise<NormalizedPosting[]> {
  return parseArbeitnow(await fetchJson(URL));
}

function epochDate(value: unknown): string | null {
  const seconds = Number(value);

  return Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000).toISOString() : null;
}
