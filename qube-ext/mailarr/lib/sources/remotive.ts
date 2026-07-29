import type { NormalizedPosting } from "../model.js";
import { asArray, asRecord, fetchJson, stripHtml, textField } from "./utils.js";

const URL = "https://remotive.com/api/remote-jobs";

export function parseRemotive(payload: unknown): NormalizedPosting[] {
  const root = asRecord(payload);

  return asArray(root.jobs)
    .map(asRecord)
    .map((job) => ({
      company: textField(job, "company_name").trim(),
      role: textField(job, "title").trim(),
      rateInfo: textField(job, "salary").trim(),
      source: "Remotive",
      url: textField(job, "url"),
      description: stripHtml(textField(job, "description")),
      publishedAt: textField(job, "publication_date") || null,
      payload: job,
    }))
    .filter((posting) => posting.company && posting.role && posting.url);
}

export async function fetchRemotive(): Promise<NormalizedPosting[]> {
  return parseRemotive(await fetchJson(URL));
}
