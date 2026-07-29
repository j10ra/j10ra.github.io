import type { DatabaseSync } from "node:sqlite";
import { extractApplyEmail, filterContactEmail } from "./extract-email.js";
import {
  getRoutine,
  getRun,
  incrementRunFoundCount,
  insertPosting,
  recordScanResult,
} from "./db.js";
import type { NormalizedPosting } from "./model.js";
import { DEFAULT_SCORE_FLOOR, scoreText } from "./score.js";
import { fetchAllSources, type ScanFetchResult } from "./sources/index.js";

export interface ScanSummary {
  found: number;
  accepted: number;
  inserted: number;
  refreshed: number;
  alreadyHandled: number;
  droppedBelowFloor: number;
  errors: string[];
  fullyFailed: boolean;
}

export interface IntakeItem {
  company: string;
  role: string;
  url: string;
  sourceLabel: string;
  contactEmail?: string;
  rateInfo?: string;
  description?: string;
  payload?: unknown;
}

export interface IntakeItemResult {
  company: string;
  url: string;
  status: "inserted" | "refreshed" | "ignored";
  score: number;
  reason?: "below_score_floor" | "already_handled";
}

export interface IntakeSummary {
  found: number;
  accepted: number;
  inserted: number;
  refreshed: number;
  alreadyHandled: number;
  droppedBelowFloor: number;
  results: IntakeItemResult[];
}

type SourceFetcher = (sourceIds: readonly string[] | null) => Promise<ScanFetchResult>;

export async function scanSources(
  db: DatabaseSync,
  runId: number,
  scoreFloor = DEFAULT_SCORE_FLOOR,
  fetchSources: SourceFetcher = fetchAllSources,
): Promise<ScanSummary> {
  const run = getRun(db, runId);

  if (run.status !== "running") throw new Error("scan_sources requires a running run");

  const routine = getRoutine(db, run.routineId);
  const fetched = await fetchSources(routine.sources);
  const fullyFailed =
    fetched.enabledSources > 0 && fetched.failedSources === fetched.enabledSources;
  let inserted = 0;
  let refreshed = 0;
  let alreadyHandled = 0;
  let droppedBelowFloor = 0;

  if (!fullyFailed) {
    for (const posting of fetched.postings) {
      const scored = scoreText(`${posting.role}\n${posting.description}`);

      if (scored.score < scoreFloor) {
        droppedBelowFloor += 1;
        continue;
      }

      const stored = insertPosting(
        db,
        run.routineId,
        run.id,
        posting,
        scored.score,
        extractApplyEmail(posting.description),
      );

      if (stored === "inserted") inserted += 1;
      else if (stored === "refreshed") refreshed += 1;
      else alreadyHandled += 1;
    }
  }

  recordScanResult(db, run.id, fetched.postings.length, fetched.errors, fullyFailed);

  return {
    found: fetched.postings.length,
    accepted: inserted + refreshed,
    inserted,
    refreshed,
    alreadyHandled,
    droppedBelowFloor,
    errors: fetched.errors,
    fullyFailed,
  };
}

export function addItems(
  db: DatabaseSync,
  routineId: number,
  runId: number,
  items: IntakeItem[],
  scoreFloor = DEFAULT_SCORE_FLOOR,
): IntakeSummary {
  const run = getRun(db, runId);

  if (run.routineId !== routineId) {
    throw new Error(`run ${runId} does not belong to routine ${routineId}`);
  }
  if (run.status !== "running") throw new Error("items_add requires a running run");

  let inserted = 0;
  let refreshed = 0;
  let alreadyHandled = 0;
  let droppedBelowFloor = 0;
  const results = items.map((item): IntakeItemResult => {
    const posting = intakePosting(item);
    const scored = scoreText(`${posting.role}\n${posting.description}`);

    if (scored.score < scoreFloor) {
      droppedBelowFloor += 1;

      return {
        company: posting.company,
        url: posting.url,
        status: "ignored",
        score: scored.score,
        reason: "below_score_floor",
      };
    }

    const status = insertPosting(
      db,
      routineId,
      runId,
      posting,
      scored.score,
      item.contactEmail ? filterContactEmail(item.contactEmail) : null,
      "intake",
    );

    if (status === "inserted") inserted += 1;
    else if (status === "refreshed") refreshed += 1;
    else alreadyHandled += 1;

    return {
      company: posting.company,
      url: posting.url,
      status,
      score: scored.score,
      ...(status === "ignored" ? { reason: "already_handled" as const } : {}),
    };
  });

  incrementRunFoundCount(db, runId, items.length);

  return {
    found: items.length,
    accepted: inserted + refreshed,
    inserted,
    refreshed,
    alreadyHandled,
    droppedBelowFloor,
    results,
  };
}

function intakePosting(item: IntakeItem): NormalizedPosting {
  return {
    company: item.company.trim(),
    role: item.role.trim(),
    rateInfo: item.rateInfo?.trim() ?? "",
    source: item.sourceLabel.trim(),
    url: item.url.trim(),
    description: item.description?.trim() ?? "",
    publishedAt: null,
    payload: item.payload ?? null,
  };
}
