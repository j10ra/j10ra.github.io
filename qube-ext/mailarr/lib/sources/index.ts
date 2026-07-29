import type { NormalizedPosting } from "../model.js";
import { BUILT_IN_SOURCES, type BuiltInSourceId } from "./catalog.js";
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
  enabledSources: number;
}

export { BUILT_IN_SOURCES, type BuiltInSourceId } from "./catalog.js";

export const SOURCES: Array<{
  id: BuiltInSourceId;
  label: string;
  fetch: () => Promise<NormalizedPosting[]>;
}> = [
  { ...BUILT_IN_SOURCES[0], fetch: fetchRemoteOk },
  { ...BUILT_IN_SOURCES[1], fetch: fetchRemotive },
  { ...BUILT_IN_SOURCES[2], fetch: fetchWeWorkRemotely },
  { ...BUILT_IN_SOURCES[3], fetch: fetchArbeitnow },
  { ...BUILT_IN_SOURCES[4], fetch: fetchJobicy },
  { ...BUILT_IN_SOURCES[5], fetch: fetchHnHiring },
];

export async function fetchAllSources(
  sourceIds: readonly string[] | null = null,
): Promise<ScanFetchResult> {
  const enabled = sourceIds
    ? SOURCES.filter((source) => sourceIds.includes(source.id))
    : SOURCES;
  const settled = await Promise.allSettled(enabled.map((source) => source.fetch()));
  const postings: NormalizedPosting[] = [];
  const errors: string[] = [];

  settled.forEach((result, index) => {
    const source = enabled[index];

    if (result.status === "fulfilled") {
      postings.push(...result.value);
    } else {
      errors.push(`${source.label}: ${message(result.reason)}`);
    }
  });

  return {
    postings,
    errors,
    failedSources: errors.length,
    enabledSources: enabled.length,
  };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
