import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  addSource,
  createRoutine,
  createRun,
  finishRun,
  getItem,
  getRoutine,
  getRun,
  hasSentCompany,
  initializeSchema,
  listItems,
  listSources,
  openMailarrDatabase,
  removeSource,
  saveBriefing,
  startRun,
  type RoutineInput,
  updateItem,
  updateSource,
} from "../lib/db.js";
import { filterContactEmail } from "../lib/contact.js";
import { addItems } from "../lib/intake.js";
import type { SourceStatus } from "../lib/model.js";
import { scoreText } from "../lib/score.js";
import {
  enforceSendGuards,
  insertVerbatimTerms,
  sendFirstContact,
} from "../lib/send.js";
import { TERMS_TOKEN, validatePitch, validateSubject } from "../lib/validate.js";
import { dryRunEnabled, mailarrMcpServer } from "../mcp.js";
import { serializeKeywordWeights } from "../web/index.js";

const BASE_ROUTINE: RoutineInput = {
  name: "General outreach",
  cron: "0 10 * * 1",
  orderText: "Follow the routine instructions.",
  dailyCap: 5,
  verbatimTerms: "Availability: 20 hours per week at $120/hr.",
  blockedTopics: ["restricted topic", "private-data"],
  requiredDisclosure: "I am an AI assistant.",
  keywords: null,
  scoreFloor: null,
};

test("fresh schema is version 1 and seeds disabled routine data with permanent history", () => {
  withDatabase((db) => {
    const version = db.prepare("PRAGMA user_version").get() as {
      user_version: number;
    };
    const routines = db.prepare("SELECT * FROM routines").all() as Array<
      Record<string, unknown>
    >;
    const sourceCount = db
      .prepare("SELECT COUNT(*) AS count FROM sources")
      .get() as { count: number };
    const history = db
      .prepare("SELECT company, dry_run FROM sent_log ORDER BY company")
      .all() as Array<{ company: string; dry_run: number }>;

    assert.equal(version.user_version, 1);
    assert.equal(routines.length, 1);
    assert.equal(routines[0].enabled, 0);
    assert.equal(routines[0].keywords, null);
    assert.equal(routines[0].score_floor, null);
    assert.equal(sourceCount.count, 0);
    assert.deepEqual(
      history.map((entry) => [entry.company, entry.dry_run]),
      [
        ["Faithlife", 0],
        ["Very Real Help", 0],
      ],
    );
    assert.equal(hasSentCompany(db, "faithlife"), true);
  });
});

test("schema rejects legacy versions instead of running compatibility migrations", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA user_version = 4");

  assert.throws(
    () => initializeSchema(db),
    /Unsupported Mailarr schema version 4/,
  );
  assert.equal(db.isTransaction, false);
  db.close();
});

test("schema initialization rechecks version under its transaction", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mailarr-schema-test-"));
  const path = join(dataDir, "mailarr.db");
  const first = new DatabaseSync(path);
  const second = new DatabaseSync(path);

  try {
    first.exec("PRAGMA busy_timeout = 5000");
    second.exec("PRAGMA busy_timeout = 5000");
    initializeSchema(first);
    initializeSchema(second);

    assert.equal(first.isTransaction, false);
    assert.equal(second.isTransaction, false);
    assert.equal(
      (second.prepare("PRAGMA user_version").get() as { user_version: number })
        .user_version,
      1,
    );
  } finally {
    first.close();
    second.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("contact filter rejects blocked and malformed addresses", () => {
  assert.equal(filterContactEmail("person@example.test"), "person@example.test");
  assert.equal(filterContactEmail("noreply@example.test"), null);
  assert.equal(filterContactEmail("privacy+case@example.test"), null);
  assert.equal(filterContactEmail("missing-at.example.test"), null);
  assert.equal(filterContactEmail("person@example"), null);
  assert.equal(filterContactEmail("person @example.test"), null);
});

test("routine source CRUD is isolated by routine", () => {
  withDatabase((db) => {
    const first = createTestRoutine(db, { name: "First" });
    const second = createTestRoutine(db, { name: "Second" });

    const added = addSource(db, {
      routineId: first.id,
      name: "Directory",
      url: "https://example.test/one",
      notes: "Primary",
    });
    addSource(db, {
      routineId: second.id,
      name: "Directory",
      url: "https://example.test/two",
    });

    assert.equal(added.name, "Directory");
    assert.equal(added.status, "candidate");
    assert.equal(listSources(db, first.id).length, 1);
    assert.equal(listSources(db, second.id)[0].url, "https://example.test/two");

    const updated = updateSource(db, {
      routineId: first.id,
      name: "Directory",
      newName: "Curated directory",
      url: "https://example.test/updated",
      notes: "Reviewed",
      status: "verified",
    });

    assert.equal(updated.name, "Curated directory");
    assert.equal(updated.notes, "Reviewed");
    assert.equal(updated.status, "verified");
    assert.deepEqual(removeSource(db, first.id, updated.name), {
      removed: true,
      routineId: first.id,
      name: "Curated directory",
    });
    assert.equal(listSources(db, first.id).length, 0);
    assert.equal(listSources(db, second.id).length, 1);
  });
});

test("routine sources reject unknown status values", () => {
  withDatabase((db) => {
    const routine = createTestRoutine(db);

    assert.throws(
      () =>
        addSource(db, {
          routineId: routine.id,
          name: "Invalid source",
          url: "https://example.test/invalid",
          status: "unknown" as SourceStatus,
        }),
      /invalid source status: unknown/,
    );

    const source = addSource(db, {
      routineId: routine.id,
      name: "Valid source",
      url: "https://example.test/valid",
    });

    assert.throws(
      () =>
        updateSource(db, {
          routineId: routine.id,
          name: source.name,
          status: "unknown" as SourceStatus,
        }),
      /invalid source status: unknown/,
    );
  });
});

test("word-boundary scoring uses only routine-provided rules", () => {
  assert.deepEqual(scoreText("builder exposure", { ui: 4, expo: 3 }), {
    score: 0,
    matches: [],
  });
  assert.deepEqual(scoreText("UI and Expo", { ui: 4, expo: 3 }), {
    score: 7,
    matches: ["ui", "expo"],
  });
});

test("keyword weights trim terms, dedupe them, and reject empty weights", () => {
  assert.deepEqual(
    serializeKeywordWeights([
      { term: " react ", weight: "2" },
      { term: "react", weight: "4" },
      { term: "  ", weight: "" },
    ]),
    { react: 4 },
  );
  assert.throws(
    () => serializeKeywordWeights([{ term: "react", weight: "" }]),
    /Weight for "react" is required/,
  );
  assert.throws(
    () => serializeKeywordWeights([{ term: "react", weight: "Infinity" }]),
    /Weight for "react" must be finite/,
  );
});

test("items_add applies a floor only when the routine defines keywords", () => {
  withDatabase((db) => {
    const unscored = createTestRoutine(db, { name: "Unscored" });
    const unscoredRun = startRun(db, createRun(db, unscored.id).id);
    const accepted = addItems(db, unscored.id, unscoredRun.id, [
      intake("Acme", "Anything", "https://example.test/a", "No matching content"),
    ]);

    assert.equal(accepted.inserted, 1);
    assert.equal(accepted.droppedBelowFloor, 0);
    assert.equal(listItems(db, {
      routineId: unscored.id,
      page: 1,
      pageSize: 10,
    }).items[0].stage, "discovered");

    const scored = createTestRoutine(db, {
      name: "Scored",
      keywords: { alpha: 3 },
      scoreFloor: 3,
    });
    const scoredRun = startRun(db, createRun(db, scored.id).id);
    const summary = addItems(db, scored.id, scoredRun.id, [
      intake("Below", "Other", "https://example.test/b", "Unrelated"),
      intake("Match", "Alpha work", "https://example.test/c", "Details"),
    ]);

    assert.equal(summary.inserted, 1);
    assert.equal(summary.droppedBelowFloor, 1);
    assert.equal(summary.results[0].reason, "below_score_floor");
    assert.equal(summary.results[1].score, 3);
  });
});

test("blocked topics use word boundaries in subject and pitch", () => {
  const subject = validateSubject({
    subject: "About restricted topic",
    blockedTopics: ["restricted topic"],
  });
  const safeBoundary = validateSubject({
    subject: "Unrestricted topical note",
    blockedTopics: ["restricted topic"],
  });
  const pitch = validatePitch({
    pitch: `I am an AI assistant.\nPrivate-data appears here.\n${BASE_ROUTINE.verbatimTerms}`,
    verbatimTerms: BASE_ROUTINE.verbatimTerms,
    blockedTopics: BASE_ROUTINE.blockedTopics,
    requiredDisclosure: BASE_ROUTINE.requiredDisclosure,
  });

  assert.equal(subject.valid, false);
  assert.match(subject.errors[0], /restricted topic/);
  assert.equal(safeBoundary.valid, true);
  assert.equal(pitch.valid, false);
  assert.match(pitch.errors[0], /private-data/);
});

test("required disclosure is routine-owned and exact", () => {
  const missing = validatePitch({
    pitch: `A different disclosure.\n${BASE_ROUTINE.verbatimTerms}`,
    verbatimTerms: BASE_ROUTINE.verbatimTerms,
    blockedTopics: [],
    requiredDisclosure: BASE_ROUTINE.requiredDisclosure,
  });
  const present = validatePitch({
    pitch: `${BASE_ROUTINE.requiredDisclosure}\nHello.\n${BASE_ROUTINE.verbatimTerms}`,
    verbatimTerms: BASE_ROUTINE.verbatimTerms,
    blockedTopics: [],
    requiredDisclosure: BASE_ROUTINE.requiredDisclosure,
  });

  assert.equal(missing.valid, false);
  assert.match(missing.errors[0], /required disclosure exactly/);
  assert.equal(present.valid, true);
});

test("every numeric character is rejected outside verbatim terms", () => {
  const termsOnly = validatePitch({
    pitch: `${BASE_ROUTINE.requiredDisclosure}\nHello.\n${BASE_ROUTINE.verbatimTerms}`,
    verbatimTerms: BASE_ROUTINE.verbatimTerms,
    blockedTopics: [],
    requiredDisclosure: BASE_ROUTINE.requiredDisclosure,
  });
  const attributed = validateSubject({
    subject: "Your listed compensation",
    blockedTopics: [],
  });

  assert.equal(termsOnly.valid, true);
  assert.equal(attributed.valid, false);

  for (const claim of [
    "150 per hour",
    "150/hr",
    "150 an hour",
    "150k a year",
    "daily fee is 1200",
    "fullwidth １５０",
    "Arabic-Indic ١٥٠",
    "circled ⑧",
    "Roman Ⅷ",
    "fraction ½",
  ]) {
    const body = validatePitch({
      pitch: `${BASE_ROUTINE.requiredDisclosure}\n${claim}\n${BASE_ROUTINE.verbatimTerms}`,
      verbatimTerms: BASE_ROUTINE.verbatimTerms,
      blockedTopics: [],
      requiredDisclosure: BASE_ROUTINE.requiredDisclosure,
    });
    const subject = validateSubject({ subject: claim, blockedTopics: [] });

    assert.equal(body.valid, false, `body accepted: ${claim}`);
    assert.equal(subject.valid, false, `subject accepted: ${claim}`);
    assert.match(body.errors.join(" "), /must not include numeric characters/);
  }
});

test("agent tool surface cannot mutate routine-owned guard data", async () => {
  await withMailarrClient(async (client) => {
    const tools = (await client.listTools()).tools;
    const names = tools.map((tool) => tool.name);
    const writableSchemas = tools
      .filter((tool) => tool.name !== "routine_get")
      .map((tool) => JSON.stringify(tool.inputSchema))
      .join("\n");

    assert.equal(names.includes("routine_update"), false);
    for (const field of [
      "verbatim_terms",
      "blocked_topics",
      "required_disclosure",
      "daily_cap",
      "keywords",
      "score_floor",
    ]) {
      assert.doesNotMatch(writableSchemas, new RegExp(field));
    }

    const attemptedMutation = await client.callTool({
      name: "routine_update",
      arguments: {
        routine_id: 1,
        daily_cap: 999,
        blocked_topics: [],
        required_disclosure: null,
        verbatim_terms: "Changed",
      },
    });

    assert.equal(attemptedMutation.isError, true);
    assert.match(JSON.stringify(attemptedMutation), /not found|unknown/iu);
  });
});

test("an agent cannot disarm guards before sending", async () => {
  await withDatabaseAsync(async (db) => {
    const routine = createTestRoutine(db, {
      blockedTopics: ["visa"],
      requiredDisclosure: "Required disclosure.",
    });
    const run = startRun(db, createRun(db, routine.id).id);
    const item = addQualifiedItem(db, routine.id, run.id, "Guarded Company", "guarded");
    let deliveries = 0;

    await assert.rejects(
      sendFirstContact({
        db,
        itemId: item.id,
        runId: run.id,
        to: item.contactEmail ?? "",
        subject: "Visa subject $400/hr",
        draft: `A message at 150 per hour.\n${TERMS_TOKEN}`,
        smtp: smtp(),
        dryRun: false,
        deliver: async () => {
          deliveries += 1;
        },
      }),
      /required disclosure|blocked topic|digits/,
    );
    assert.equal(deliveries, 0);
  });
});

test("verbatim terms replace the token exactly once", () => {
  assert.equal(
    insertVerbatimTerms(`Hello\n${TERMS_TOKEN}`, "Exact\nblock"),
    "Hello\nExact\nblock",
  );
  assert.throws(() => insertVerbatimTerms("Hello", "Exact"), /exactly once/);
  assert.throws(
    () => insertVerbatimTerms(`${TERMS_TOKEN}\n${TERMS_TOKEN}`, "Exact"),
    /exactly once/,
  );
});

test("dry runs count toward the cap without creating permanent dedupe", async () => {
  await withDatabaseAsync(async (db) => {
    const routine = createTestRoutine(db, { dailyCap: 1 });
    const run = startRun(db, createRun(db, routine.id).id);
    const item = addQualifiedItem(db, routine.id, run.id, "Dry Company", "dry");
    let deliveries = 0;

    const result = await sendFirstContact({
      db,
      itemId: item.id,
      runId: run.id,
      to: item.contactEmail ?? "",
      subject: "Hello",
      draft: validDraft(routine.requiredDisclosure),
      smtp: smtp(),
      dryRun: true,
      now: new Date("2030-01-02T01:00:00.000Z"),
      deliver: async () => {
        deliveries += 1;
      },
    });

    assert.equal(result.dryRun, true);
    assert.equal(deliveries, 0);
    assert.equal(hasSentCompany(db, item.company), false);
    updateItem(db, item.id, { stage: "qualified" });

    await assert.rejects(
      sendFirstContact({
        db,
        itemId: item.id,
        runId: run.id,
        to: item.contactEmail ?? "",
        subject: "Hello again",
        draft: validDraft(routine.requiredDisclosure),
        smtp: smtp(),
        dryRun: false,
        now: new Date("2030-01-02T02:00:00.000Z"),
        deliver: async () => {
          deliveries += 1;
        },
      }),
      /Daily cap of 1 reached/,
    );
  });
});

test("real sends deliver once and permanently dedupe the company", async () => {
  await withDatabaseAsync(async (db) => {
    const routine = createTestRoutine(db);
    const run = startRun(db, createRun(db, routine.id).id);
    const first = addQualifiedItem(db, routine.id, run.id, "Permanent Company", "one");
    let deliveries = 0;

    await sendFirstContact({
      db,
      itemId: first.id,
      runId: run.id,
      to: first.contactEmail ?? "",
      subject: "Hello",
      draft: validDraft(routine.requiredDisclosure),
      smtp: smtp(),
      dryRun: false,
      deliver: async () => {
        deliveries += 1;
      },
    });

    assert.equal(deliveries, 1);
    assert.equal(hasSentCompany(db, first.company), true);

    const second = addQualifiedItem(
      db,
      routine.id,
      run.id,
      "Permanent Company",
      "two",
    );

    await assert.rejects(
      sendFirstContact({
        db,
        itemId: second.id,
        runId: run.id,
        to: second.contactEmail ?? "",
        subject: "Again",
        draft: validDraft(routine.requiredDisclosure),
        smtp: smtp(),
        dryRun: false,
        deliver: async () => {
          deliveries += 1;
        },
      }),
      /already been contacted/,
    );
    assert.equal(deliveries, 1);
  });
});

test("send requires the recipient to match the stored contact", async () => {
  await withDatabaseAsync(async (db) => {
    const routine = createTestRoutine(db);
    const run = startRun(db, createRun(db, routine.id).id);
    const item = addQualifiedItem(db, routine.id, run.id, "Recipient Company", "one");

    await assert.rejects(
      sendFirstContact({
        db,
        itemId: item.id,
        runId: run.id,
        to: "other@example.test",
        subject: "Hello",
        draft: validDraft(routine.requiredDisclosure),
        smtp: smtp(),
        dryRun: true,
      }),
      /Recipient must match/,
    );
  });
});

test("send guards require a qualified item and matching routine", () => {
  withDatabase((db) => {
    const firstRoutine = createTestRoutine(db, { name: "First guard routine" });
    const secondRoutine = createTestRoutine(db, { name: "Second guard routine" });
    const firstRun = startRun(db, createRun(db, firstRoutine.id).id);
    const secondRun = startRun(db, createRun(db, secondRoutine.id).id);
    const summary = addItems(db, firstRoutine.id, firstRun.id, [
      intake(
        "Guard Company",
        "Contact",
        "https://example.test/guard",
        "General details",
      ),
    ]);
    const item = listItems(db, {
      routineId: firstRoutine.id,
      runId: firstRun.id,
      page: 1,
      pageSize: 10,
    }).items[0];

    assert.equal(summary.inserted, 1);
    assert.throws(
      () => enforceSendGuards(db, { itemId: item.id, runId: firstRun.id }),
      /Only qualified items/,
    );
    assert.throws(
      () => enforceSendGuards(db, { itemId: item.id, runId: secondRun.id }),
      /same routine/,
    );
  });
});

test("run_finish without a briefing records a failed run", () => {
  withDatabase((db) => {
    const routine = createTestRoutine(db);
    const run = startRun(db, createRun(db, routine.id).id);

    assert.throws(
      () => finishRun(db, run.id, "done"),
      /requires a briefing/,
    );
    const failed = getRun(db, run.id);

    assert.equal(failed.status, "failed");
    assert.equal(failed.errorText, "Run finished without a briefing");
  });
});

test("a source-maintenance run can finish successfully without sending", () => {
  withDatabase((db) => {
    const routine = createTestRoutine(db);
    const run = startRun(db, createRun(db, routine.id).id);

    addSource(db, {
      routineId: routine.id,
      name: "New source",
      url: "https://example.test/source",
    });
    saveBriefing(db, run.id, "# Briefing\n\nSource list refreshed.");
    const finished = finishRun(db, run.id, "done");

    assert.equal(finished.status, "done");
    assert.equal(finished.sentCount, 0);
  });
});

test("dry-run defaults on when unset and parses explicit false values", () => {
  assert.equal(dryRunEnabled({}), true);
  assert.equal(dryRunEnabled({ dry_run: "" }), true);
  assert.equal(dryRunEnabled({ dry_run: true }), true);
  assert.equal(dryRunEnabled({ dry_run: "false" }), false);
  assert.equal(dryRunEnabled({ dry_run: 0 }), false);
});

function createTestRoutine(
  db: DatabaseSync,
  overrides: Partial<RoutineInput> = {},
) {
  return createRoutine(db, {
    ...BASE_ROUTINE,
    name: `${overrides.name ?? BASE_ROUTINE.name} ${Math.random()}`,
    ...overrides,
  });
}

function intake(
  company: string,
  role: string,
  url: string,
  description: string,
) {
  return {
    company,
    role,
    url,
    sourceLabel: "Agent source",
    contactEmail: "person@example.test",
    description,
  };
}

function addQualifiedItem(
  db: DatabaseSync,
  routineId: number,
  runId: number,
  company: string,
  slug: string,
) {
  const summary = addItems(db, routineId, runId, [
    intake(company, "Contact", `https://example.test/${slug}`, "General details"),
  ]);
  const items = listItems(db, { routineId, runId, page: 1, pageSize: 100 }).items;
  const item = items.find((entry) => entry.company === company && entry.url.endsWith(slug));

  assert.equal(summary.accepted, 1);
  assert.ok(item);

  return updateItem(db, item.id, { stage: "qualified" });
}

function validDraft(disclosure: string | null): string {
  return `${disclosure ?? ""}\nHello.\n${TERMS_TOKEN}`;
}

function smtp() {
  return {
    host: "smtp.example.test",
    port: 465,
    user: "user",
    password: "secret",
    fromAddress: "sender@example.test",
  };
}

function withDatabase(action: (db: DatabaseSync) => void): void {
  const dataDir = mkdtempSync(join(tmpdir(), "mailarr-test-"));
  const db = openMailarrDatabase(dataDir);

  try {
    action(db);
  } finally {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
}

async function withDatabaseAsync(
  action: (db: DatabaseSync) => Promise<void>,
): Promise<void> {
  const dataDir = mkdtempSync(join(tmpdir(), "mailarr-test-"));
  const db = openMailarrDatabase(dataDir);

  try {
    await action(db);
  } finally {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
}

async function withMailarrClient(
  action: (client: Client) => Promise<void>,
): Promise<void> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = mailarrMcpServer(() => {
    throw new Error("test context is unavailable");
  });
  const client = new Client({ name: "mailarr-test", version: "1.0.0" });

  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  try {
    await action(client);
  } finally {
    await client.close();
    await server.close();
  }
}
