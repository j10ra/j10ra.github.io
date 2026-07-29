import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  createRoutine,
  createRun,
  finishRun,
  getItem,
  hasSentCompany,
  insertPosting,
  latestBriefing,
  openMailarrDatabase,
  recordScanResult,
  recordSent,
  saveBriefing,
  sentTodayCount,
  startRun,
  updateItem,
} from "../lib/db.js";
import { extractApplyEmail } from "../lib/extract-email.js";
import { dryRunEnabled } from "../mcp.js";
import { scoreText } from "../lib/score.js";
import {
  enforceSendGuards,
  formatCommercialTerms,
  insertCommercialTerms,
  sendFirstContact,
} from "../lib/send.js";
import {
  COMMERCIAL_TERMS_TOKEN,
  SEBE_DISCLOSURE,
  validatePitch,
  validateSubject,
} from "../lib/validate.js";

test("scoreText uses word boundaries for short terms", () => {
  const result = scoreText("We build exposure tooling", { ui: 2, expo: 3 });

  assert.equal(result.score, 0);
  assert.deepEqual(result.matches, []);

  const exact = scoreText("Design UI with Expo", { ui: 2, expo: 3 });

  assert.equal(exact.score, 5);
  assert.deepEqual(exact.matches.sort(), ["expo", "ui"]);

  assert.equal(scoreText("Senior full-stack engineer").matches.includes("full stack"), true);
});

test("extractApplyEmail rejects dead locals and requires apply context", () => {
  const text = [
    "Questions can go to person@example.com.",
    "To apply, email jobs@example.com or send your CV to hiring.manager@example.com.",
  ].join(" ");

  assert.equal(extractApplyEmail(text), "hiring.manager@example.com");
  assert.equal(extractApplyEmail("Owner: person@example.com. General company profile."), null);
  assert.equal(
    extractApplyEmail(
      "Apply by email to careers+eng@example.com, jobs-apply@example.com, or hr.team@example.com.",
    ),
    null,
  );
});

test("validatePitch blocks visa mentions", () => {
  const terms = termsText();
  const result = validatePitch({
    pitch: `${SEBE_DISCLOSURE}\nCan the company sponsor a visa?\n${terms}`,
    postingText: "Senior TypeScript engineer",
    commercialTerms: terms,
  });

  assert.equal(result.valid, false);
  assert.match(result.errors.join(" "), /visa/i);
});

test("validatePitch blocks invented pay ranges", () => {
  const terms = termsText();
  const result = validatePitch({
    pitch: `${SEBE_DISCLOSURE}\nThe role pays $90 - $120/hr.\n${terms}`,
    postingText: "Senior TypeScript engineer. Compensation is $70/hr.",
    commercialTerms: terms,
  });

  assert.equal(result.valid, false);
  assert.match(result.errors.join(" "), /absent from the posting/i);
});

test("validatePitch requires the exact Sebe disclosure", () => {
  const terms = termsText();
  const result = validatePitch({
    pitch: `I am an assistant for Jetz.\n${terms}`,
    postingText: "Senior TypeScript engineer",
    commercialTerms: terms,
  });

  assert.equal(result.valid, false);
  assert.match(result.errors.join(" "), /disclosure line exactly/i);
});

test("validateSubject applies visa and invented pay guards", () => {
  const visa = validateSubject({
    subject: "Visa sponsorship for a TypeScript role",
    postingText: "Senior TypeScript engineer",
  });
  const pay = validateSubject({
    subject: "$90 - $120/hr TypeScript role",
    postingText: "Senior TypeScript engineer. Compensation is $70/hr.",
  });

  assert.equal(visa.valid, false);
  assert.match(visa.errors.join(" "), /visa/i);
  assert.equal(pay.valid, false);
  assert.match(pay.errors.join(" "), /absent from the posting/i);
});

test("commercial terms are formatted by code and inserted once", () => {
  const terms = termsText();
  const pitch = insertCommercialTerms(
    `${SEBE_DISCLOSURE}\nHello.\n${COMMERCIAL_TERMS_TOKEN}`,
    terms,
  );

  assert.match(pitch, /Hourly floor: TEST 10/);
  assert.equal(pitch.includes(COMMERCIAL_TERMS_TOKEN), false);
  assert.throws(
    () => insertCommercialTerms("No token", terms),
    /must include \{\{COMMERCIAL_TERMS\}\} exactly once/,
  );
  assert.equal(
    insertCommercialTerms(`Terms:\n${COMMERCIAL_TERMS_TOKEN}`, "Keep $& exactly"),
    "Terms:\nKeep $& exactly",
  );
});

test("send guards enforce the daily cap and permanent company dedupe", () => {
  const db = testDatabase();
  const routine = createRoutine(db, {
    name: "Guard test",
    cron: "0 9 * * *",
    orderText: "Test guard behavior",
    dailyCap: 1,
  });
  const firstRun = startRun(db, createRun(db, routine.id).id);
  const firstId = addQualifiedItem(db, routine.id, firstRun.id, "First Co", "https://first.test");
  const sentAt = new Date().toISOString();

  recordSent(db, {
    company: "First Co",
    email: "person@first.test",
    subject: "Hello",
    body: "Body",
    sentAt,
    runId: firstRun.id,
    dryRun: false,
    itemId: firstId,
  });

  const secondRun = startRun(db, createRun(db, routine.id).id);
  const secondId = addQualifiedItem(
    db,
    routine.id,
    secondRun.id,
    "Second Co",
    "https://second.test",
  );

  assert.throws(
    () => enforceSendGuards(db, { itemId: secondId, runId: secondRun.id }),
    /Daily cap of 1 reached/,
  );

  const otherRoutine = createRoutine(db, {
    name: "Dedupe test",
    cron: "0 10 * * *",
    orderText: "Test dedupe behavior",
    dailyCap: 5,
  });
  const dedupeRun = startRun(db, createRun(db, otherRoutine.id).id);
  const duplicateId = addQualifiedItem(
    db,
    otherRoutine.id,
    dedupeRun.id,
    "First Co",
    "https://different.test",
  );

  assert.throws(
    () => enforceSendGuards(db, { itemId: duplicateId, runId: dedupeRun.id }),
    /already been contacted/,
  );

  db.close();
});

test("dry run records the complete email without delivering it", async () => {
  const db = testDatabase();
  const routine = createRoutine(db, {
    name: "Dry run",
    cron: "0 9 * * *",
    orderText: "Test dry run behavior",
    dailyCap: 5,
  });
  const run = startRun(db, createRun(db, routine.id).id);
  const itemId = addQualifiedItem(db, routine.id, run.id, "Dry Co", "https://dry.test");
  let delivered = false;
  const result = await sendFirstContact({
    db,
    itemId,
    runId: run.id,
    to: "person@dry.test",
    subject: "Senior TypeScript role",
    draft: `${SEBE_DISCLOSURE}\nHello from Sebe.\n${COMMERCIAL_TERMS_TOKEN}`,
    commercial: {
      hourlyFloor: "TEST 10",
      targetRate: "TEST 20",
      premiumBand: "TEST 30 to TEST 40",
      weeklyHours: "TEST 5",
    },
    smtp: { user: "", password: "", fromAddress: "" },
    dryRun: true,
    deliver: async () => {
      delivered = true;
    },
  });
  const row = db.prepare("SELECT body, dry_run FROM sent_log WHERE run_id = ?").get(run.id) as {
    body: string;
    dry_run: number;
  };

  assert.equal(delivered, false);
  assert.equal(result.dryRun, true);
  assert.equal(row.dry_run, 1);
  assert.match(row.body, /Commercial terms provided by Jetz/);
  assert.equal(sentTodayCount(db, routine.id), 0);
  assert.equal(hasSentCompany(db, "Dry Co"), false);
  assert.equal(getItem(db, itemId).stage, "qualified");

  await sendFirstContact({
    db,
    itemId,
    runId: run.id,
    to: "person@dry.test",
    subject: "Senior TypeScript role",
    draft: `${SEBE_DISCLOSURE}\nHello from Sebe.\n${COMMERCIAL_TERMS_TOKEN}`,
    commercial: {
      hourlyFloor: "TEST 10",
      targetRate: "TEST 20",
      premiumBand: "TEST 30 to TEST 40",
      weeklyHours: "TEST 5",
    },
    smtp: { user: "", password: "", fromAddress: "" },
    dryRun: false,
    deliver: async () => {
      delivered = true;
    },
  });

  assert.equal(delivered, true);
  assert.equal(sentTodayCount(db, routine.id), 1);
  assert.equal(hasSentCompany(db, "Dry Co"), true);
  assert.equal(getItem(db, itemId).stage, "contacted");
  assert.equal(
    Number(
      (
        db.prepare("SELECT COUNT(*) AS count FROM sent_log WHERE normalized_company = 'dry co'").get() as {
          count: number;
        }
      ).count,
    ),
    2,
  );
  db.close();
});

test("send rejects subjects that violate content guards", async () => {
  const db = testDatabase();
  const routine = createRoutine(db, {
    name: "Subject guard",
    cron: "0 9 * * *",
    orderText: "Test subject guards",
    dailyCap: 5,
  });
  const run = startRun(db, createRun(db, routine.id).id);
  const itemId = addQualifiedItem(db, routine.id, run.id, "Subject Co", "https://subject.test");
  const base = {
    db,
    itemId,
    runId: run.id,
    to: "person@subject.test",
    draft: `${SEBE_DISCLOSURE}\nHello.\n${COMMERCIAL_TERMS_TOKEN}`,
    commercial: {
      hourlyFloor: "TEST 10",
      targetRate: "TEST 20",
      premiumBand: "TEST 30 to TEST 40",
      weeklyHours: "TEST 5",
    },
    smtp: { user: "", password: "", fromAddress: "" },
    dryRun: true,
    deliver: async () => {},
  };

  await assert.rejects(
    sendFirstContact({ ...base, subject: "Visa sponsorship question" }),
    /Subject must not mention visas/i,
  );
  await assert.rejects(
    sendFirstContact({ ...base, subject: "$90 - $120\/hr TypeScript role" }),
    /Subject includes a pay fact absent from the posting/i,
  );
  db.close();
});

test("send rejects a recipient that differs from the extracted address", async () => {
  const db = testDatabase();
  const routine = createRoutine(db, {
    name: "Recipient guard",
    cron: "0 9 * * *",
    orderText: "Test recipient guard",
    dailyCap: 5,
  });
  const run = startRun(db, createRun(db, routine.id).id);
  const itemId = addQualifiedItem(
    db,
    routine.id,
    run.id,
    "Recipient Co",
    "https://recipient.test",
  );

  await assert.rejects(
    sendFirstContact({
      db,
      itemId,
      runId: run.id,
      to: "other@example.test",
      subject: "Senior TypeScript role",
      draft: `${SEBE_DISCLOSURE}\nHello.\n${COMMERCIAL_TERMS_TOKEN}`,
      commercial: {
        hourlyFloor: "TEST 10",
        targetRate: "TEST 20",
        premiumBand: "TEST 30 to TEST 40",
        weeklyHours: "TEST 5",
      },
      smtp: { user: "", password: "", fromAddress: "" },
      dryRun: true,
      deliver: async () => {},
    }),
    /Recipient must match/,
  );
  db.close();
});

test("rediscovered uncontacted items move to the current run", () => {
  const db = testDatabase();
  const routine = createRoutine(db, {
    name: "Rediscovery",
    cron: "0 9 * * *",
    orderText: "Test rediscovery",
    dailyCap: 5,
  });
  const firstRun = startRun(db, createRun(db, routine.id).id);
  const posting = testPosting("Rediscovered Co", "https://rediscovered.test");

  assert.equal(insertPosting(db, routine.id, firstRun.id, posting, 10, "person@rediscovered.test"), "inserted");
  const itemRow = db
    .prepare("SELECT id FROM items WHERE normalized_company = 'rediscovered co'")
    .get() as { id: number };
  updateItem(db, itemRow.id, { stage: "qualified" });

  const secondRun = startRun(db, createRun(db, routine.id).id);
  assert.equal(
    insertPosting(db, routine.id, secondRun.id, posting, 11, "person@rediscovered.test"),
    "refreshed",
  );
  assert.equal(getItem(db, itemRow.id).runId, secondRun.id);
  assert.doesNotThrow(() =>
    enforceSendGuards(db, { itemId: itemRow.id, runId: secondRun.id }),
  );
  db.close();
});

test("dry run defaults on for unset and unknown config values", () => {
  assert.equal(dryRunEnabled({}), true);
  assert.equal(dryRunEnabled({ dry_run: "unexpected" }), true);
  assert.equal(dryRunEnabled({ dry_run: "false" }), false);
  assert.equal(dryRunEnabled({ dry_run: false }), false);
});

test("initial migration seeds Job Scout and permanent contacted companies once", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mailarr-seed-test-"));
  let db = openMailarrDatabase(dataDir);
  const routine = db
    .prepare("SELECT name, enabled, daily_cap FROM routines WHERE name = 'Job Scout'")
    .get() as { name: string; enabled: number; daily_cap: number };
  const companies = db
    .prepare("SELECT company FROM sent_log WHERE dry_run = 0 ORDER BY company")
    .all() as Array<{ company: string }>;
  const version = db.prepare("PRAGMA user_version").get() as { user_version: number };

  assert.equal(routine.name, "Job Scout");
  assert.equal(routine.enabled, 0);
  assert.equal(routine.daily_cap, 5);
  assert.deepEqual(
    companies.map((row) => row.company),
    ["Faithlife", "Very Real Help"],
  );
  assert.equal(version.user_version, 2);
  db.close();

  db = openMailarrDatabase(dataDir);
  const count = db.prepare("SELECT COUNT(*) AS count FROM sent_log").get() as { count: number };

  assert.equal(count.count, 2);
  db.close();
});

test("legacy sent_log uniqueness migrates to real-send-only dedupe", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mailarr-legacy-test-"));
  const path = join(dataDir, "mailarr.db");
  let db = new DatabaseSync(path);

  db.exec(`
    CREATE TABLE sent_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company TEXT NOT NULL,
      normalized_company TEXT NOT NULL UNIQUE,
      email TEXT NOT NULL,
      subject TEXT NOT NULL,
      body TEXT NOT NULL,
      sent_at TEXT NOT NULL,
      run_id INTEGER,
      dry_run INTEGER NOT NULL DEFAULT 0 CHECK (dry_run IN (0, 1))
    );
    INSERT INTO sent_log
      (company, normalized_company, email, subject, body, sent_at, run_id, dry_run)
    VALUES
      ('Legacy Dry', 'legacy dry', 'first@example.test', 'Preview', 'Body',
       '2026-07-28T00:00:00.000Z', NULL, 1);
  `);
  db.close();

  db = openMailarrDatabase(dataDir);
  db.prepare(`
    INSERT INTO sent_log
      (company, normalized_company, email, subject, body, sent_at, run_id, dry_run)
    VALUES (?, ?, ?, ?, ?, ?, NULL, 1)
  `).run(
    "Legacy Dry",
    "legacy dry",
    "second@example.test",
    "Preview 2",
    "Body 2",
    "2026-07-29T00:00:00.000Z",
  );
  const count = db
    .prepare("SELECT COUNT(*) AS count FROM sent_log WHERE normalized_company = 'legacy dry'")
    .get() as { count: number };

  assert.equal(count.count, 2);
  assert.equal(hasSentCompany(db, "Legacy Dry"), false);
  db.close();
});

test("source errors are appended to briefings and fully failed runs remain failed", () => {
  const db = testDatabase();
  const routine = createRoutine(db, {
    name: "Failed scan",
    cron: "0 9 * * *",
    orderText: "Test source errors",
    dailyCap: 5,
  });
  const run = startRun(db, createRun(db, routine.id).id);

  recordScanResult(db, run.id, 0, ["RemoteOK: HTTP 503", "Jobicy: timeout"], true);
  saveBriefing(db, run.id, "# Briefing\n\nNo sources succeeded.");
  const finished = finishRun(db, run.id, "done");
  const briefing = latestBriefing(db, routine.id);

  assert.equal(finished.status, "failed");
  assert.match(briefing?.markdown ?? "", /## Source errors/);
  assert.match(briefing?.markdown ?? "", /RemoteOK: HTTP 503/);
  db.close();
});

function termsText(): string {
  return formatCommercialTerms({
    hourlyFloor: "TEST 10",
    targetRate: "TEST 20",
    premiumBand: "TEST 30 to TEST 40",
    weeklyHours: "TEST 5",
  });
}

function testDatabase() {
  return openMailarrDatabase(mkdtempSync(join(tmpdir(), "mailarr-test-")));
}

function addQualifiedItem(
  db: ReturnType<typeof testDatabase>,
  routineId: number,
  runId: number,
  company: string,
  url: string,
): number {
  insertPosting(
    db,
    routineId,
    runId,
    testPosting(company, url),
    10,
    `person@${new URL(url).hostname}`,
  );
  const row = db.prepare("SELECT id FROM items WHERE run_id = ? AND company = ?").get(runId, company) as {
    id: number;
  };

  updateItem(db, row.id, { stage: "qualified" });

  return row.id;
}

function testPosting(company: string, url: string) {
  return {
    company,
    role: "Senior TypeScript Engineer",
    rateInfo: "",
    source: "Test",
    url,
    description: "Senior TypeScript Engineer",
    publishedAt: null,
    payload: {},
  };
}
