import type { DatabaseSync } from "node:sqlite";
import { filterContactEmail } from "./contact.js";
import {
  getRoutine,
  getRun,
  incrementRunFoundCount,
  insertIntakeItem,
  type IntakeRecord,
} from "./db.js";
import { scoreText } from "./score.js";

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

export function addItems(
  db: DatabaseSync,
  routineId: number,
  runId: number,
  items: IntakeItem[],
): IntakeSummary {
  const run = getRun(db, runId);

  if (run.routineId !== routineId) {
    throw new Error(`run ${runId} does not belong to routine ${routineId}`);
  }
  if (run.status !== "running") throw new Error("items_add requires a running run");

  const routine = getRoutine(db, routineId);
  let inserted = 0;
  let refreshed = 0;
  let alreadyHandled = 0;
  let droppedBelowFloor = 0;
  const results = items.map((item): IntakeItemResult => {
    const record = intakeRecord(item);
    const score = routine.keywords
      ? scoreText(`${record.role}\n${record.description}`, routine.keywords).score
      : 0;

    if (
      routine.keywords &&
      routine.scoreFloor !== null &&
      score < routine.scoreFloor
    ) {
      droppedBelowFloor += 1;

      return {
        company: record.company,
        url: record.url,
        status: "ignored",
        score,
        reason: "below_score_floor",
      };
    }

    const status = insertIntakeItem(
      db,
      routineId,
      runId,
      record,
      score,
      item.contactEmail ? filterContactEmail(item.contactEmail) : null,
    );

    if (status === "inserted") inserted += 1;
    else if (status === "refreshed") refreshed += 1;
    else alreadyHandled += 1;

    return {
      company: record.company,
      url: record.url,
      status,
      score,
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

function intakeRecord(item: IntakeItem): IntakeRecord {
  return {
    company: item.company.trim(),
    role: item.role.trim(),
    rateInfo: item.rateInfo?.trim() ?? "",
    source: item.sourceLabel.trim(),
    url: item.url.trim(),
    description: item.description?.trim() ?? "",
    payload: item.payload ?? null,
  };
}
