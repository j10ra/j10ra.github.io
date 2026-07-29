import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createRoutine,
  createRun,
  finishRun,
  insertPosting,
  latestBriefing,
  openMailarrDatabase,
  recordScanResult,
  recordSent,
  saveBriefing,
  startRun,
  updateItem,
} from "../lib/db.js";
import { extractApplyEmail } from "../lib/extract-email.js";
import { scoreText } from "../lib/score.js";
import {
  enforceSendGuards,
  formatCommercialTerms,
  insertCommercialTerms,
  sendFirstContact,
} from "../lib/send.js";
import { COMMERCIAL_TERMS_TOKEN, SEBE_DISCLOSURE, validatePitch } from "../lib/validate.js";

test("scoreText uses word boundaries for short terms", () => {
  const result = scoreText("We build exposure tooling", { ui: 2, expo: 3 });

  assert.equal(result.score, 0);
  assert.deepEqual(result.matches, []);

  const exact = scoreText("Design UI with Expo", { ui: 2, expo: 3 });

  assert.equal(exact.score, 5);
  assert.deepEqual(exact.matches.sort(), ["expo", "ui"]);
});

test("extractApplyEmail rejects dead locals and requires apply context", () => {
  const text = [
    "Questions can go to person@example.com.",
    "To apply, email jobs@example.com or send your CV to hiring.manager@example.com.",
  ].join(" ");

  assert.equal(extractApplyEmail(text), "hiring.manager@example.com");
  assert.equal(extractApplyEmail("Owner: person@example.com. General company profile."), null);
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
    dryRun: true,
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
    {
      company,
      role: "Senior TypeScript Engineer",
      rateInfo: "",
      source: "Test",
      url,
      description: "Senior TypeScript Engineer",
      publishedAt: null,
      payload: {},
    },
    10,
    `person@${new URL(url).hostname}`,
  );
  const row = db.prepare("SELECT id FROM items WHERE run_id = ? AND company = ?").get(runId, company) as {
    id: number;
  };

  updateItem(db, row.id, { stage: "qualified" });

  return row.id;
}
