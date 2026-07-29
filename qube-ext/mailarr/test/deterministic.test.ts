import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { ExtensionContext } from "@qube-code/extension-sdk";
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
  routineDashboard,
  saveBriefing,
  setRoutineFrozen,
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
import { registerMailarrRoutes } from "../routes.js";
import mailarr, {
  editorRoutineId,
  openPipelineEditor,
  pendingAge,
  serializeKeywordWeights,
} from "../web/index.js";

const BASE_ROUTINE: RoutineInput = {
  name: "General outreach",
  cron: "0 10 * * 1",
  orderText: "Follow the routine instructions.",
  session: null,
  sessionLabel: null,
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
    assert.equal(routines[0].frozen, 0);
    assert.equal(routines[0].session, null);
    assert.equal(routines[0].session_label, null);
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

test("panel routes persist routine session bindings through create and update", async () => {
  await withPanelRoutes(async (routes, dataDir) => {
    const createdResponse = (await routes.call(
      "POST",
      "/api/mailarr/routines",
      {
        ...BASE_ROUTINE,
        name: "Bound routine",
        session: "qube_cc_j10ra-github-io_2",
        sessionLabel: "claude · sonnet",
      },
    )) as RoutineResponse;

    assert.equal(createdResponse.routine.session, "qube_cc_j10ra-github-io_2");
    assert.equal(createdResponse.routine.sessionLabel, "claude · sonnet");

    const updatedResponse = (await routes.call(
      "PUT",
      "/api/mailarr/routines/:id",
      {
        ...BASE_ROUTINE,
        name: "Bound routine",
        session: "qube_cx_j10ra-github-io_3",
        sessionLabel: "codex · gpt-5.6-sol",
      },
      { id: String(createdResponse.routine.id) },
    )) as RoutineResponse;

    assert.equal(updatedResponse.routine.session, "qube_cx_j10ra-github-io_3");
    assert.equal(updatedResponse.routine.sessionLabel, "codex · gpt-5.6-sol");

    const db = openMailarrDatabase(dataDir);
    try {
      const persisted = getRoutine(db, createdResponse.routine.id);

      assert.equal(persisted.session, "qube_cx_j10ra-github-io_3");
      assert.equal(persisted.sessionLabel, "codex · gpt-5.6-sol");
    } finally {
      db.close();
    }
  });
});

test("routines_due carries routine session bindings", async () => {
  await withDatabaseAsync(async (db, dataDir) => {
    const routine = createTestRoutine(db, {
      session: "qube_cc_j10ra-github-io_2",
      sessionLabel: "claude · sonnet",
    });
    createRun(db, routine.id);

    await withMailarrClient(async (client) => {
      const response = await client.callTool({
        name: "routines_due",
        arguments: {},
      });
      const content = response.content as Array<{ type: string; text?: string }>;

      assert.equal(response.isError, undefined);
      assert.equal(content[0]?.type, "text");
      const runs = JSON.parse(content[0]?.text ?? "[]") as Array<{
        session: string | null;
        sessionLabel: string | null;
      }>;

      assert.equal(runs.length, 1);
      assert.equal(runs[0].session, "qube_cc_j10ra-github-io_2");
      assert.equal(runs[0].sessionLabel, "claude · sonnet");

      const routineResponse = await client.callTool({
        name: "routine_get",
        arguments: { routine_id: routine.id },
      });
      const routineContent = routineResponse.content as Array<{
        type: string;
        text?: string;
      }>;
      const fetched = JSON.parse(routineContent[0]?.text ?? "{}") as {
        session: string | null;
        sessionLabel: string | null;
      };

      assert.equal(fetched.session, "qube_cc_j10ra-github-io_2");
      assert.equal(fetched.sessionLabel, "claude · sonnet");
    }, dataDir);
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

test("routine dashboard reports whether a run is pending", () => {
  withDatabase((db) => {
    const routine = createTestRoutine(db);
    const dashboardRoutine = () =>
      routineDashboard(db).find((entry) => entry.id === routine.id);

    assert.equal(dashboardRoutine()?.hasPendingRun, false);
    assert.equal(dashboardRoutine()?.pendingRun, null);
    const run = createRun(db, routine.id);

    assert.equal(dashboardRoutine()?.hasPendingRun, true);
    assert.equal(dashboardRoutine()?.pendingRun?.id, run.id);
    startRun(db, run.id);
    assert.equal(dashboardRoutine()?.hasPendingRun, false);
    assert.equal(dashboardRoutine()?.pendingRun, null);
  });
});

test("panel cancellation fails a pending run and clears the escape hatch", async () => {
  await withPanelRoutes(async (routes, dataDir) => {
    const db = openMailarrDatabase(dataDir);
    let routineId: number;
    let runId: number;

    try {
      const routine = createTestRoutine(db);
      routineId = routine.id;
      runId = createRun(db, routine.id).id;
    } finally {
      db.close();
    }

    const response = (await routes.call(
      "POST",
      "/api/mailarr/routines/:id/cancel-pending",
      {},
      { id: String(routineId) },
    )) as { run: { id: number; status: string; errorText: string | null } };

    assert.equal(response.run.id, runId);
    assert.equal(response.run.status, "failed");
    assert.equal(response.run.errorText, "cancelled from panel");

    const reopened = openMailarrDatabase(dataDir);
    try {
      assert.equal(
        routineDashboard(reopened).find((routine) => routine.id === routineId)
          ?.pendingRun,
        null,
      );
    } finally {
      reopened.close();
    }
  });
});

test("pending age uses compact minute, hour, and day labels", () => {
  const now = new Date("2030-01-03T12:00:00.000Z");

  assert.equal(pendingAge("2030-01-03T11:59:45.000Z", now), "<1m");
  assert.equal(pendingAge("2030-01-03T11:35:00.000Z", now), "25m");
  assert.equal(pendingAge("2030-01-03T06:00:00.000Z", now), "6h");
  assert.equal(pendingAge("2030-01-01T12:00:00.000Z", now), "2d");
});

test("pipeline editor opens only when the host API succeeds", () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const setWindow = (value: unknown) =>
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      writable: true,
      value,
    });

  try {
    assert.ok(mailarr.editors?.some((editor) => editor.id === "pipeline"));
    assert.equal(editorRoutineId({ routineId: 7 }), 7);
    assert.equal(editorRoutineId({ routineId: 0 }), null);
    assert.equal(editorRoutineId({}), null);

    setWindow({});
    assert.equal(openPipelineEditor(11, { id: 7, name: "Scout" }), false);

    let opened: { worktreeId: number; spec: unknown } | null = null;

    setWindow({
      __QUBE_SHARED__: {
        editorTabs: {
          open: (worktreeId: number, spec: unknown) => {
            opened = { worktreeId, spec };
          },
        },
      },
    });

    assert.equal(openPipelineEditor(11, { id: 7, name: "Scout" }), true);
    assert.deepEqual(opened, {
      worktreeId: 11,
      spec: {
        ext: "mailarr",
        editor: "pipeline",
        key: "routine:7",
        title: "Scout",
        payload: { routineId: 7 },
      },
    });

    setWindow({
      __QUBE_SHARED__: {
        editorTabs: {
          open: () => {
            throw new Error("editor rejected");
          },
        },
      },
    });
    assert.equal(openPipelineEditor(11, { id: 7, name: "Scout" }), false);
  } finally {
    if (originalWindow) {
      Object.defineProperty(globalThis, "window", originalWindow);
    } else {
      Reflect.deleteProperty(globalThis, "window");
    }
  }
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

test("agent routine writes exclude panel-only fields and fail while frozen", async () => {
  await withDatabaseAsync(async (db, dataDir) => {
    const routine = createTestRoutine(db);
    setRoutineFrozen(db, routine.id, true);

    await withMailarrClient(async (client) => {
      const tools = (await client.listTools()).tools;
      const routineUpdate = tools.find((tool) => tool.name === "routine_update");
      const writableSchemas = tools
        .filter((tool) => tool.name !== "routine_get")
        .map((tool) => JSON.stringify(tool.inputSchema))
        .join("\n");

      assert.ok(routineUpdate);
      for (const field of [
        "daily_cap",
        "session",
        "session_label",
        "enabled",
        "frozen",
      ]) {
        assert.doesNotMatch(writableSchemas, new RegExp(field));
      }
      for (const field of [
        "order_text",
        "verbatim_terms",
        "blocked_topics",
        "required_disclosure",
        "keywords",
        "score_floor",
      ]) {
        assert.match(JSON.stringify(routineUpdate.inputSchema), new RegExp(field));
      }

      for (const change of [
        { order_text: "Changed order" },
        { verbatim_terms: "Changed terms" },
        { blocked_topics: ["changed topic"] },
        { required_disclosure: "Changed disclosure" },
        { keywords: { react: 2 } },
        { score_floor: 2 },
      ]) {
        const response = await client.callTool({
          name: "routine_update",
          arguments: { routine_id: routine.id, ...change },
        });

        assert.equal(response.isError, true);
        assert.match(JSON.stringify(response), /routine is frozen/iu);
      }
    }, dataDir);
  });
});

test("routine_update reuses panel content validation", async () => {
  await withDatabaseAsync(async (db, dataDir) => {
    const routine = createTestRoutine(db);

    await withMailarrClient(async (client) => {
      for (const [change, expected] of [
        [{ order_text: "   " }, /routine order is required/iu],
        [{ verbatim_terms: "   " }, /verbatim terms are required/iu],
        [{ blocked_topics: [1] }, /string/iu],
        [{ keywords: { " ": 2 } }, /non-empty terms/iu],
        [{ score_floor: 2 }, /score floor requires keywords/iu],
      ] as const) {
        const response = await client.callTool({
          name: "routine_update",
          arguments: { routine_id: routine.id, ...change },
        });

        assert.equal(response.isError, true);
        assert.match(JSON.stringify(response), expected);
      }
    }, dataDir);
  });
});

test("unlock edit send fails, then panel freeze enforces current content guards", async () => {
  await withPanelRoutes(async (routes, dataDir) => {
    const created = (await routes.call("POST", "/api/mailarr/routines", {
      ...BASE_ROUTINE,
      name: "Lifecycle routine",
    })) as RoutineResponse;
    const routineId = created.routine.id;

    assert.equal(created.routine.frozen, false);

    await withMailarrClient(async (client) => {
      const response = await client.callTool({
        name: "routine_update",
        arguments: {
          routine_id: routineId,
          order_text: "  Current agent order.  ",
          verbatim_terms: "Current commercial terms.",
          blocked_topics: [" current-topic ", "current-topic"],
          required_disclosure: "  Current disclosure.  ",
          keywords: { " general ": 3 },
          score_floor: 2,
        },
      });

      assert.equal(response.isError, undefined);
    }, dataDir);

    const db = openMailarrDatabase(dataDir);
    try {
      const edited = getRoutine(db, routineId);

      assert.equal(edited.orderText, "Current agent order.");
      assert.equal(edited.verbatimTerms, "Current commercial terms.");
      assert.deepEqual(edited.blockedTopics, ["current-topic"]);
      assert.equal(edited.requiredDisclosure, "Current disclosure.");
      assert.deepEqual(edited.keywords, { general: 3 });
      assert.equal(edited.scoreFloor, 2);

      const run = startRun(db, createRun(db, routineId).id);
      const item = addQualifiedItem(
        db,
        routineId,
        run.id,
        "Current Guard Co",
        "current",
      );
      let deliveries = 0;
      const send = (subject: string, draft: string) =>
        sendFirstContact({
          db,
          itemId: item.id,
          runId: run.id,
          to: item.contactEmail ?? "",
          subject,
          draft,
          smtp: smtp(),
          dryRun: false,
          deliver: async () => {
            deliveries += 1;
          },
        });

      await assert.rejects(
        send("Hello", `Current disclosure.\nHello.\n${TERMS_TOKEN}`),
        /routine is unlocked for editing/,
      );

      const frozen = (await routes.call(
        "POST",
        "/api/mailarr/routines/:id/freeze",
        { frozen: true },
        { id: String(routineId) },
      )) as RoutineResponse;

      assert.equal(frozen.routine.frozen, true);
      await assert.rejects(
        send("Hello 2", `Current disclosure.\nHello.\n${TERMS_TOKEN}`),
        /numeric characters/,
      );
      await assert.rejects(
        send("current-topic", `Current disclosure.\nHello.\n${TERMS_TOKEN}`),
        /blocked topic/,
      );
      await assert.rejects(
        send("Hello", `Hello.\n${TERMS_TOKEN}`),
        /required disclosure/,
      );

      const result = await send(
        "Hello",
        `Current disclosure.\nHello.\n${TERMS_TOKEN}`,
      );

      assert.equal(deliveries, 1);
      assert.match(result.body, /Current commercial terms\./);
    } finally {
      db.close();
    }
  });
});

test("unlocked routines refuse sends even in dry-run mode", async () => {
  await withDatabaseAsync(async (db, dataDir) => {
    const routine = createTestRoutine(db);
    const run = startRun(db, createRun(db, routine.id).id);
    const item = addQualifiedItem(
      db,
      routine.id,
      run.id,
      "Unlocked Company",
      "dry",
    );

    await withMailarrClient(async (client) => {
      const response = await client.callTool({
        name: "send_first_contact",
        arguments: {
          run_id: run.id,
          item_id: item.id,
          subject: "Hello",
          pitch: validDraft(routine.requiredDisclosure),
        },
      });

      assert.equal(response.isError, true);
      assert.match(JSON.stringify(response), /routine is unlocked for editing/iu);
    }, dataDir);
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
    setRoutineFrozen(db, routine.id, true);
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
    setRoutineFrozen(db, routine.id, true);
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
    setRoutineFrozen(db, routine.id, true);
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
    setRoutineFrozen(db, firstRoutine.id, true);
    setRoutineFrozen(db, secondRoutine.id, true);
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
  action: (db: DatabaseSync, dataDir: string) => Promise<void>,
): Promise<void> {
  const dataDir = mkdtempSync(join(tmpdir(), "mailarr-test-"));
  const db = openMailarrDatabase(dataDir);

  try {
    await action(db, dataDir);
  } finally {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
}

async function withMailarrClient(
  action: (client: Client) => Promise<void>,
  dataDir?: string,
): Promise<void> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = mailarrMcpServer(() => {
    if (dataDir) {
      return {
        dataDir,
        broadcast: () => undefined,
      } as unknown as ExtensionContext;
    }

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

interface RoutineResponse {
  routine: {
    id: number;
    session: string | null;
    sessionLabel: string | null;
    frozen: boolean;
  };
}

type PanelMethod = "GET" | "POST" | "PUT";
type PanelRequest = {
  body?: unknown;
  params: Record<string, string>;
  query: Record<string, string>;
};
type PanelReply = {
  code: (status: number) => {
    send: (body: unknown) => unknown;
  };
};
type PanelHandler = (
  request: PanelRequest,
  reply: PanelReply,
) => Promise<unknown>;

async function withPanelRoutes(
  action: (
    routes: {
      call: (
        method: PanelMethod,
        path: string,
        body?: unknown,
        params?: Record<string, string>,
      ) => Promise<unknown>;
    },
    dataDir: string,
  ) => Promise<void>,
): Promise<void> {
  const dataDir = mkdtempSync(join(tmpdir(), "mailarr-routes-test-"));
  const handlers = new Map<string, PanelHandler>();
  const register =
    (method: PanelMethod) => (path: string, handler: PanelHandler) => {
      handlers.set(`${method} ${path}`, handler);
    };
  const app = {
    get: register("GET"),
    post: register("POST"),
    put: register("PUT"),
  } as unknown as Parameters<typeof registerMailarrRoutes>[0];
  const ctx = {
    dataDir,
    broadcast: () => undefined,
  } as unknown as ExtensionContext;

  registerMailarrRoutes(app, () => ctx);

  try {
    await action(
      {
        call: async (method, path, body, params = {}) => {
          const handler = handlers.get(`${method} ${path}`);

          assert.ok(handler, `route not registered: ${method} ${path}`);

          return handler(
            { body, params, query: {} },
            {
              code: (status) => ({
                send: (responseBody) => ({ status, body: responseBody }),
              }),
            },
          );
        },
      },
      dataDir,
    );
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
}
