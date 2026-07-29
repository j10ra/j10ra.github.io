import type { NormalizedPosting } from "../model.js";
import { decodeHtml, extractRateInfo, fetchText, stripHtml } from "./utils.js";

const URL = "https://weworkremotely.com/categories/remote-programming-jobs.rss";

export function parseWeWorkRemotely(payload: unknown): NormalizedPosting[] {
  if (typeof payload !== "string") throw new Error("Expected an RSS string");

  return [...payload.matchAll(/<item>([\s\S]*?)<\/item>/giu)]
    .map((match) => match[1])
    .map((item) => {
      const title = decodeHtml(tag(item, "title")).trim();
      const separator = title.indexOf(":");
      const descriptionHtml = decodeHtml(tag(item, "description"));
      const description = stripHtml(descriptionHtml);

      return {
        company: (separator === -1 ? title : title.slice(0, separator)).trim(),
        role: (separator === -1 ? title : title.slice(separator + 1)).trim(),
        rateInfo: extractRateInfo(description),
        source: "WeWorkRemotely",
        url: decodeHtml(tag(item, "link") || tag(item, "guid")).trim(),
        description,
        publishedAt: tag(item, "pubDate").trim() || null,
        payload: item,
      };
    })
    .filter((posting) => posting.company && posting.role && posting.url);
}

export async function fetchWeWorkRemotely(): Promise<NormalizedPosting[]> {
  return parseWeWorkRemotely(await fetchText(URL));
}

function tag(xml: string, name: string): string {
  const match = xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, "iu"));

  return match?.[1] ?? "";
}
