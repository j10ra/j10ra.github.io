import type { DatabaseSync } from "node:sqlite";
import { extractApplyEmail } from "./extract-email.js";
import { getRun, insertPosting, recordScanResult } from "./db.js";
import { DEFAULT_SCORE_FLOOR, scoreText } from "./score.js";
import { fetchAllSources, SOURCES } from "./sources/index.js";

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

export async function scanSources(
  db: DatabaseSync,
  runId: number,
  scoreFloor = DEFAULT_SCORE_FLOOR,
): Promise<ScanSummary> {
  const run = getRun(db, runId);

  if (run.status !== "running") throw new Error("scan_sources requires a running run");

  const fetched = await fetchAllSources();
  const fullyFailed = fetched.failedSources === SOURCES.length;
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
