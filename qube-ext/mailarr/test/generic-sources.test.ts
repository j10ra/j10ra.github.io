import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  createRoutine,
  createRun,
  getItem,
  getRoutine,
  listRoutines,
  openMailarrDatabase,
  startRun,
} from "../lib/db.js";
import type { NormalizedPosting } from "../lib/model.js";
import { addItems, scanSources } from "../lib/scan.js";
import { DEFAULT_SCORE_FLOOR } from "../lib/score.js";
import {
  BUILT_IN_SOURCES,
  SOURCES,
} from "../lib/sources/index.js";

test("items_add applies scanner guards and refreshes scanned items", async () => {
  const db = testDatabase();
  const routine = createRoutine(db, {
    name: "Generic intake",
    cron: "0 9 * * *",
    orderText: "Fetch selected sources",
    dailyCap: 5,
  });
  const run = startRun(db, createRun(db, routine.id).id);
  const scanned = posting("Existing Co", "https://example.test/existing");

  await scanSources(db, run.id, DEFAULT_SCORE_FLOOR, async () => ({
    postings: [scanned],
    errors: [],
    failedSources: 0,
    enabledSources: BUILT_IN_SOURCES.length,
  }));

  const summary = addItems(db, routine.id, run.id, [
    {
      company: scanned.company,
      role: "Senior React Architect",
      url: scanned.url,
      sourceLabel: "Agent directory",
      contactEmail: "hiring@example.test",
      description: "Senior React and TypeScript work",
      payload: { refreshed: true },
    },
    {
      company: "Below Floor Co",
      role: "Office coordinator",
      url: "https://example.test/below-floor",
      sourceLabel: "Agent directory",
      description: "General administration",
    },
    {
      company: "Blacklisted Co",
      role: "Senior TypeScript Engineer",
      url: "https://example.test/blacklisted",
      sourceLabel: "Agent directory",
      contactEmail: "careers@example.test",
      description: "Senior TypeScript product work",
    },
    {
      company: "Invalid Contact Co",
      role: "Senior TypeScript Engineer",
      url: "https://example.test/invalid-contact",
      sourceLabel: "Agent directory",
      contactEmail: "not-an-email",
      description: "Senior TypeScript product work",
    },
  ]);

  assert.deepEqual(
    summary.results.map(({ status, reason }) => ({ status, reason })),
    [
      { status: "refreshed", reason: undefined },
      { status: "ignored", reason: "below_score_floor" },
      { status: "inserted", reason: undefined },
      { status: "inserted", reason: undefined },
    ],
  );
  assert.equal(summary.inserted, 2);
  assert.equal(summary.refreshed, 1);
  assert.equal(summary.droppedBelowFloor, 1);
  assert.equal(summary.alreadyHandled, 0);

  const existingRow = db
    .prepare("SELECT id FROM items WHERE normalized_company = 'existing co'")
    .get() as { id: number };
  const blacklistedRow = db
    .prepare("SELECT id FROM items WHERE normalized_company = 'blacklisted co'")
    .get() as { id: number };
  const invalidRow = db
    .prepare("SELECT id FROM items WHERE normalized_company = 'invalid contact co'")
    .get() as { id: number };
  const refreshed = getItem(db, existingRow.id);

  assert.equal(refreshed.role, "Senior React Architect");
  assert.equal(refreshed.source, "Agent directory");
  assert.equal(refreshed.contactEmail, "hiring@example.test");
  assert.equal(getItem(db, blacklistedRow.id).contactEmail, null);
  assert.equal(getItem(db, invalidRow.id).contactEmail, null);
  assert.equal(
    (
      db.prepare("SELECT COUNT(*) AS count FROM items WHERE normalized_company = 'below floor co'").get() as {
        count: number;
      }
    ).count,
    0,
  );
  assert.equal(
    (db.prepare("SELECT found_count FROM runs WHERE id = ?").get(run.id) as { found_count: number })
      .found_count,
    5,
  );
  db.close();
});

test("scan_sources filters to the routine subset and fails against the enabled count", async () => {
  const db = testDatabase();
  const routine = createRoutine(db, {
    name: "Filtered scan",
    cron: "0 9 * * *",
    orderText: "Only selected built-ins",
    dailyCap: 5,
    sources: ["remoteok", "jobicy"],
  });
  const partialRun = startRun(db, createRun(db, routine.id).id);
  const originalFetchers = SOURCES.map((source) => source.fetch);
  const requested: string[] = [];
  let partial: Awaited<ReturnType<typeof scanSources>>;

  try {
    for (const source of SOURCES) {
      source.fetch = async () => {
        requested.push(source.id);

        if (source.id === "jobicy") throw new Error("timeout");

        return [posting("Subset Co", "https://example.test/subset")];
      };
    }
    partial = await scanSources(db, partialRun.id);
  } finally {
    SOURCES.forEach((source, index) => {
      source.fetch = originalFetchers[index];
    });
  }

  assert.deepEqual(requested, ["remoteok", "jobicy"]);
  assert.equal(partial.fullyFailed, false);

  const failedRun = startRun(db, createRun(db, routine.id).id);
  const failed = await scanSources(db, failedRun.id, DEFAULT_SCORE_FLOOR, async (sourceIds) => ({
    postings: [],
    errors: ["RemoteOK: timeout", "Jobicy: timeout"],
    failedSources: 2,
    enabledSources: sourceIds?.length ?? BUILT_IN_SOURCES.length,
  }));

  assert.equal(failed.fullyFailed, true);
  assert.equal(
    (db.prepare("SELECT status FROM runs WHERE id = ?").get(failedRun.id) as { status: string })
      .status,
    "failed",
  );
  db.close();
});

test("migration upgrades v2 routines with null sources", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mailarr-v2-sources-test-"));
  const path = join(dataDir, "mailarr.db");
  let db = new DatabaseSync(path);

  db.exec(`
    CREATE TABLE routines (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      cron TEXT NOT NULL,
      order_text TEXT NOT NULL,
      daily_cap INTEGER NOT NULL CHECK (daily_cap > 0),
      enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    INSERT INTO routines
      (name, cron, order_text, daily_cap, enabled, created_at, updated_at)
    VALUES
      ('Legacy Routine', '0 9 * * *', 'Legacy order', 5, 0,
       '2026-07-28T00:00:00.000Z', '2026-07-28T00:00:00.000Z');
    PRAGMA user_version = 2;
  `);
  db.close();

  db = openMailarrDatabase(dataDir);

  assert.equal(
    (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version,
    3,
  );
  assert.equal(getRoutine(db, 1).sources, null);
  assert.equal(
    (db.prepare("PRAGMA table_info(routines)").all() as Array<{ name: string }>).some(
      ({ name }) => name === "sources",
    ),
    true,
  );
  db.close();
});

test("fresh migration seeds Job Scout with every built-in source enabled", () => {
  const db = testDatabase();
  const jobScout = listRoutines(db).find((routine) => routine.name === "Job Scout");

  assert.ok(jobScout);
  const enabledSources =
    jobScout.sources ?? BUILT_IN_SOURCES.map((source) => source.id);

  assert.equal(
    (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version,
    3,
  );
  assert.equal(jobScout.sources, null);
  assert.deepEqual(enabledSources, BUILT_IN_SOURCES.map((source) => source.id));
  db.close();
});

function testDatabase() {
  return openMailarrDatabase(mkdtempSync(join(tmpdir(), "mailarr-generic-test-")));
}

function posting(company: string, url: string): NormalizedPosting {
  return {
    company,
    role: "Senior TypeScript Engineer",
    rateInfo: "$100/hr",
    source: "RemoteOK",
    url,
    description:
      "Senior TypeScript and React engineer. Apply by email to person@example.test.",
    publishedAt: null,
    payload: { captured: true },
  };
}
