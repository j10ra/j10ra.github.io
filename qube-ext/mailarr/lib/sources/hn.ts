import type { NormalizedPosting } from "../model.js";
import { asArray, asRecord, extractRateInfo, fetchJson, stripHtml, textField } from "./utils.js";

const SEARCH_URL =
  "https://hn.algolia.com/api/v1/search_by_date?tags=story,ask_hn&query=Ask%20HN%3A%20Who%20is%20hiring%3F&hitsPerPage=20";

export function parseHnHiring(payload: unknown): NormalizedPosting[] {
  const root = asRecord(payload);

  return asArray(root.children)
    .map(asRecord)
    .filter((comment) => textField(comment, "text"))
    .map((comment) => {
      const description = stripHtml(textField(comment, "text"));
      const firstLine = description.split("\n")[0] ?? "";
      const fields = firstLine.split("|").map((value) => value.trim());
      const company = fields[0] || `HN hiring post ${textField(comment, "id")}`;
      const role = fields.slice(1).join(" | ") || firstLine;
      const id = textField(comment, "id");

      return {
        company,
        role,
        rateInfo: extractRateInfo(description),
        source: "HN Who is hiring",
        url: `https://news.ycombinator.com/item?id=${encodeURIComponent(id)}`,
        description,
        publishedAt: textField(comment, "created_at") || null,
        payload: comment,
      };
    })
    .filter((posting) => posting.company && posting.role);
}

export async function fetchHnHiring(): Promise<NormalizedPosting[]> {
  const search = asRecord(await fetchJson(SEARCH_URL));
  const hit = asArray(search.hits)
    .map(asRecord)
    .find((entry) => /^Ask HN: Who is hiring\?/iu.test(textField(entry, "title")));
  const id = hit ? textField(hit, "objectID") : "";

  if (!id) throw new Error("No recent HN Who is hiring thread found");

  return parseHnHiring(await fetchJson(`https://hn.algolia.com/api/v1/items/${id}`));
}
