import type { NormalizedPosting } from "../model.js";
import { asArray, asRecord, extractRateInfo, fetchJson, stripHtml, textField } from "./utils.js";

const URL = "https://jobicy.com/api/v2/remote-jobs?count=50&industry=dev";

export function parseJobicy(payload: unknown): NormalizedPosting[] {
  const root = asRecord(payload);

  return asArray(root.jobs)
    .map(asRecord)
    .map((job) => {
      const description = stripHtml(textField(job, "jobDescription"));

      return {
        company: textField(job, "companyName").trim(),
        role: textField(job, "jobTitle").trim(),
        rateInfo: salary(job) || extractRateInfo(description),
        source: "Jobicy",
        url: textField(job, "url"),
        description,
        publishedAt: textField(job, "pubDate") || null,
        payload: job,
      };
    })
    .filter((posting) => posting.company && posting.role && posting.url);
}

export async function fetchJobicy(): Promise<NormalizedPosting[]> {
  return parseJobicy(await fetchJson(URL));
}

function salary(job: Record<string, unknown>): string {
  const minimum = textField(job, "annualSalaryMin");
  const maximum = textField(job, "annualSalaryMax");
  const currency = textField(job, "salaryCurrency");

  if (!minimum && !maximum) return "";

  return [currency, minimum && maximum ? `${minimum} - ${maximum}` : minimum || maximum]
    .filter(Boolean)
    .join(" ");
}
