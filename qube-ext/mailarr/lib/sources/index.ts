import type { NormalizedPosting } from "../model.js";
import { fetchArbeitnow } from "./arbeitnow.js";
import { fetchHnHiring } from "./hn.js";
import { fetchJobicy } from "./jobicy.js";
import { fetchRemoteOk } from "./remoteok.js";
import { fetchRemotive } from "./remotive.js";
import { fetchWeWorkRemotely } from "./weworkremotely.js";

export interface ScanFetchResult {
  postings: NormalizedPosting[];
  errors: string[];
  failedSources: number;
}

const SOURCES: Array<{ name: string; fetch: () => Promise<NormalizedPosting[]> }> = [
  { name: "RemoteOK", fetch: fetchRemoteOk },
  { name: "Remotive", fetch: fetchRemotive },
  { name: "WeWorkRemotely", fetch: fetchWeWorkRemotely },
  { name: "Arbeitnow", fetch: fetchArbeitnow },
  { name: "Jobicy", fetch: fetchJobicy },
  { name: "HN Who is hiring", fetch: fetchHnHiring },
];

export async function fetchAllSources(): Promise<ScanFetchResult> {
  const settled = await Promise.allSettled(SOURCES.map((source) => source.fetch()));
  const postings: NormalizedPosting[] = [];
  const errors: string[] = [];

  settled.forEach((result, index) => {
    const source = SOURCES[index];

    if (result.status === "fulfilled") {
      postings.push(...result.value);
    } else {
      errors.push(`${source.name}: ${message(result.reason)}`);
    }
  });

  return { postings, errors, failedSources: errors.length };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
