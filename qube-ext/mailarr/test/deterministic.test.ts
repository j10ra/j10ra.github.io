import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { ExtensionContext } from "@qube-code/extension-sdk";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  addSource,
  createRoutine,
  createRun,
  deleteItem,
  finishRun,
  getItem,
  getRoutine,
  getRun,
  hasSentCompany,
  initializeSchema,
  latestBriefing,
  listItems,
  listSources,
  MANUAL_PANEL_BRIEFING_PREFIX,
  openMailarrDatabase,
  removeSource,
  routineDashboard,
  saveBriefing,
  setRoutineDryRun,
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
import { mailarrMcpServer } from "../mcp.js";
import { registerMailarrRoutes } from "../routes.js";
import mailarr, {
  BriefingMarkdown,
  briefingSummary,
  createMemoryStore,
  openRoutineWorkbench,
  pendingAge,
  routineIdFromWorkbenchKey,
  serializeKeywordWeights,
  showingRange,
  workbenchTarget,
} from "../web/index.js";

const BASE_ROUTINE: RoutineInput = {
  name: "General outreach",
  cron: "0 10 * * 1",
  orderText: "Follow the routine instructions.",
  session: null,
  sessionLabel: null,
  worktreeId: null,
  dailyCap: 5,
  verbatimTerms: "Availability: 20 hours per week at $120/hr.",
  blockedTopics: ["restricted topic", "private-data"],
  requiredDisclosure: "I am an AI assistant.",
  keywords: null,
  scoreFloor: null,
  dryRun: true,
};

test("fresh schema is version 4 and seeds a disabled dry-run routine with permanent history", () => {
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

    assert.equal(version.user_version, 4);
    const itemColumns = db.prepare("PRAGMA table_info(items)").all() as Array<{
      name: string;
    }>;
    const routineColumns = db.prepare("PRAGMA table_info(routines)").all() as Array<{
      name: string;
      dflt_value: string | null;
    }>;

    assert.ok(itemColumns.some((column) => column.name === "draft_subject"));
    assert.equal(
      routineColumns.find((column) => column.name === "dry_run")?.dflt_value,
      "1",
    );
    assert.equal(routines.length, 1);
    assert.equal(routines[0].enabled, 0);
    assert.equal(routines[0].frozen, 0);
    assert.equal(routines[0].frozen_at, null);
    assert.equal(routines[0].session, null);
    assert.equal(routines[0].session_label, null);
    assert.equal(routines[0].worktree_id, null);
    assert.equal(routines[0].keywords, null);
    assert.equal(routines[0].score_floor, null);
    assert.equal(routines[0].dry_run, 1);
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

test("manifest declares agent notification capability", () => {
  const manifest = JSON.parse(
    readFileSync(new URL("../extension.json", import.meta.url), "utf8"),
  ) as { version: string; capabilities: string[] };

  assert.equal(manifest.version, "0.9.0");
  assert.ok(manifest.capabilities.includes("agent-notify"));
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
        worktreeId: 73088147,
      },
    )) as RoutineResponse;

    assert.equal(createdResponse.routine.session, "qube_cc_j10ra-github-io_2");
    assert.equal(createdResponse.routine.sessionLabel, "claude · sonnet");
    assert.equal(createdResponse.routine.worktreeId, 73088147);

    const updatedResponse = (await routes.call(
      "PUT",
      "/api/mailarr/routines/:id",
      {
        ...BASE_ROUTINE,
        name: "Bound routine",
        session: "qube_cx_j10ra-github-io_3",
        sessionLabel: "codex · gpt-5.6-sol",
        worktreeId: 73088148,
        reviewedUpdatedAt: createdResponse.routine.updatedAt,
      },
      { id: String(createdResponse.routine.id) },
    )) as RoutineResponse;

    assert.equal(updatedResponse.routine.session, "qube_cx_j10ra-github-io_3");
    assert.equal(updatedResponse.routine.sessionLabel, "codex · gpt-5.6-sol");
    assert.equal(updatedResponse.routine.worktreeId, 73088148);

    const db = openMailarrDatabase(dataDir);
    try {
      const persisted = getRoutine(db, createdResponse.routine.id);

      assert.equal(persisted.session, "qube_cx_j10ra-github-io_3");
      assert.equal(persisted.sessionLabel, "codex · gpt-5.6-sol");
      assert.equal(persisted.worktreeId, 73088148);
    } finally {
      db.close();
    }
  });
});

test("panel dry-run PUT toggles the routine mode", async () => {
  await withPanelRoutes(async (routes, dataDir) => {
    const created = (await routes.call("POST", "/api/mailarr/routines", {
      ...BASE_ROUTINE,
      name: "Mode toggle routine",
    })) as RoutineResponse;

    assert.equal(created.routine.dryRun, true);

    const live = (await routes.call(
      "PUT",
      "/api/mailarr/routines/:id/dry-run",
      { dryRun: false },
      { id: String(created.routine.id) },
    )) as RoutineResponse;

    assert.equal(live.routine.dryRun, false);

    const dry = (await routes.call(
      "PUT",
      "/api/mailarr/routines/:id/dry-run",
      { dryRun: true },
      { id: String(created.routine.id) },
    )) as RoutineResponse;

    assert.equal(dry.routine.dryRun, true);

    const db = openMailarrDatabase(dataDir);
    try {
      assert.equal(getRoutine(db, created.routine.id).dryRun, true);
    } finally {
      db.close();
    }
  });
});

test("run now returns agent nudge delivery outcomes without losing runs", async () => {
  let behavior: "nudged" | "queued" | "refused" | "throws" = "nudged";
  const notifications: Array<{
    worktreeId: number;
    text: string;
    nudgeId?: string;
  }> = [];

  await withPanelRoutes(
    async (routes) => {
      const created = (await routes.call("POST", "/api/mailarr/routines", {
        ...BASE_ROUTINE,
        name: "Push routine",
        worktreeId: 73088147,
      })) as RoutineResponse;
      const params = { id: String(created.routine.id) };

      const nudged = (await routes.call(
        "POST",
        "/api/mailarr/routines/:id/run",
        {},
        params,
      )) as RunDeliveryRouteResponse;

      assert.equal(nudged.delivery, "nudged");

      behavior = "queued";
      const queued = (await routes.call(
        "POST",
        "/api/mailarr/routines/:id/run",
        {},
        params,
      )) as RunDeliveryRouteResponse;

      assert.equal(queued.delivery, "queued");

      behavior = "refused";
      const refused = (await routes.call(
        "POST",
        "/api/mailarr/routines/:id/run",
        {},
        params,
      )) as RunDeliveryRouteResponse;

      assert.deepEqual(
        { delivery: refused.delivery, refusal: refused.refusal },
        { delivery: "polling fallback", refusal: "rate-limited" },
      );

      behavior = "throws";
      const failed = (await routes.call(
        "POST",
        "/api/mailarr/routines/:id/run",
        {},
        params,
      )) as RunDeliveryRouteResponse;

      assert.deepEqual(
        { delivery: failed.delivery, refusal: failed.refusal },
        { delivery: "polling fallback", refusal: "delivery-failed" },
      );
      assert.deepEqual(
        notifications.map(({ worktreeId, nudgeId }) => ({ worktreeId, nudgeId })),
        [
          { worktreeId: 73088147, nudgeId: `mailarr-run-${nudged.run.id}` },
          { worktreeId: 73088147, nudgeId: `mailarr-run-${queued.run.id}` },
          { worktreeId: 73088147, nudgeId: `mailarr-run-${refused.run.id}` },
          { worktreeId: 73088147, nudgeId: `mailarr-run-${failed.run.id}` },
        ],
      );
    },
    {
      notifyAgent: async (input) => {
        notifications.push(input);

        if (behavior === "throws") throw new Error("delivery transport unavailable");
        if (behavior === "refused") {
          return { ok: false, refused: "rate-limited" };
        }

        return { ok: true, queued: behavior === "queued" };
      },
    },
  );
});

test("routine edit rejects stale forms and accepts a reload retry", async () => {
  await withPanelRoutes(async (routes) => {
    const created = (await routes.call("POST", "/api/mailarr/routines", {
      ...BASE_ROUTINE,
      name: "Staleness protected",
    })) as RoutineResponse;
    const routineId = created.routine.id;

    const missingBinding = (await routes.call(
      "PUT",
      "/api/mailarr/routines/:id",
      {
        ...BASE_ROUTINE,
        name: "Unbound panel edit",
      },
      { id: String(routineId) },
    )) as { status: number; body: { error: string } };

    assert.equal(missingBinding.status, 400);
    assert.match(missingBinding.body.error, /reviewed updated time is required/);

    const agentEdit = (await routes.call(
      "PUT",
      "/api/mailarr/routines/:id",
      {
        ...BASE_ROUTINE,
        name: "Agent edit",
        reviewedUpdatedAt: created.routine.updatedAt,
      },
      { id: String(routineId) },
    )) as RoutineResponse;

    const staleSave = (await routes.call(
      "PUT",
      "/api/mailarr/routines/:id",
      {
        ...BASE_ROUTINE,
        name: "Stale panel edit",
        reviewedUpdatedAt: created.routine.updatedAt,
      },
      { id: String(routineId) },
    )) as { status: number; body: { error: string } };

    assert.equal(staleSave.status, 400);
    assert.match(staleSave.body.error, /reload current values and retry/);

    const retried = (await routes.call(
      "PUT",
      "/api/mailarr/routines/:id",
      {
        ...BASE_ROUTINE,
        name: "Reloaded panel edit",
        reviewedUpdatedAt: agentEdit.routine.updatedAt,
      },
      { id: String(routineId) },
    )) as RoutineResponse;

    assert.ok(retried.routine.updatedAt > agentEdit.routine.updatedAt);
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
        dryRun: boolean;
      }>;

      assert.equal(runs.length, 1);
      assert.equal(runs[0].session, "qube_cc_j10ra-github-io_2");
      assert.equal(runs[0].sessionLabel, "claude · sonnet");
      assert.equal(runs[0].dryRun, true);

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
        dryRun: boolean;
      };

      assert.equal(fetched.session, "qube_cc_j10ra-github-io_2");
      assert.equal(fetched.sessionLabel, "claude · sonnet");
      assert.equal(fetched.dryRun, true);
    }, dataDir);
  });
});

test("schema rejects v3 with database deletion guidance", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA user_version = 3");

  assert.throws(
    () => initializeSchema(db),
    /Unsupported Mailarr schema version 3; delete mailarr\.db/,
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
      4,
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
    assert.equal(dashboardRoutine()?.pendingRunCount, 0);
    const run = createRun(db, routine.id);

    assert.equal(dashboardRoutine()?.hasPendingRun, true);
    assert.equal(dashboardRoutine()?.pendingRun?.id, run.id);
    assert.equal(dashboardRoutine()?.pendingRunCount, 1);
    startRun(db, run.id);
    assert.equal(dashboardRoutine()?.hasPendingRun, false);
    assert.equal(dashboardRoutine()?.pendingRun, null);
    assert.equal(dashboardRoutine()?.pendingRunCount, 0);
  });
});

test("panel cancellation clears one pending run or the full stack", async () => {
  await withPanelRoutes(async (routes, dataDir) => {
    const db = openMailarrDatabase(dataDir);
    let routineId: number;
    let runIds: number[];

    try {
      const routine = createTestRoutine(db);
      routineId = routine.id;
      runIds = [
        createRun(db, routine.id).id,
        createRun(db, routine.id).id,
        createRun(db, routine.id).id,
      ];
    } finally {
      db.close();
    }

    const response = (await routes.call(
      "POST",
      "/api/mailarr/routines/:id/cancel-pending",
      {},
      { id: String(routineId) },
    )) as {
      run: { id: number; status: string; errorText: string | null };
      cancelled: number;
    };

    assert.equal(response.cancelled, 1);
    assert.equal(response.run.id, runIds[0]);
    assert.equal(response.run.status, "failed");
    assert.equal(response.run.errorText, "cancelled from panel");

    const reopened = openMailarrDatabase(dataDir);
    try {
      const dashboard = routineDashboard(reopened).find(
        (routine) => routine.id === routineId,
      );

      assert.equal(dashboard?.pendingRun?.id, runIds[1]);
      assert.equal(dashboard?.pendingRunCount, 2);
    } finally {
      reopened.close();
    }

    const allResponse = (await routes.call(
      "POST",
      "/api/mailarr/routines/:id/cancel-pending",
      { all: true },
      { id: String(routineId) },
    )) as {
      runs: Array<{ id: number; status: string; errorText: string | null }>;
      cancelled: number;
    };

    assert.equal(allResponse.cancelled, 2);
    assert.deepEqual(
      allResponse.runs.map((run) => run.id),
      runIds.slice(1),
    );
    assert.ok(
      allResponse.runs.every(
        (run) =>
          run.status === "failed" && run.errorText === "cancelled from panel",
      ),
    );

    const final = openMailarrDatabase(dataDir);
    try {
      const dashboard = routineDashboard(final).find(
        (routine) => routine.id === routineId,
      );

      assert.equal(dashboard?.pendingRun, null);
      assert.equal(dashboard?.pendingRunCount, 0);
    } finally {
      final.close();
    }
  });
});

test("panel pipeline paginates each stage and validates page inputs", async () => {
  await withPanelRoutes(async (routes, dataDir) => {
    const db = openMailarrDatabase(dataDir);
    let routineId: number;
    let discoveredPageIds: number[];

    try {
      const routine = createTestRoutine(db);
      routineId = routine.id;
      const run = startRun(db, createRun(db, routine.id).id);
      const items = Array.from({ length: 13 }, (_, index) =>
        intake(
          `Company ${index + 1}`,
          `Role ${index + 1}`,
          `https://example.test/pipeline-${index + 1}`,
          "General details",
        ),
      );

      addItems(db, routine.id, run.id, items);
      const allItems = listItems(db, {
        routineId: routine.id,
        page: 1,
        pageSize: 20,
      }).items;

      for (const item of allItems.slice(0, 3)) {
        updateItem(db, item.id, { stage: "qualified" });
      }

      discoveredPageIds = listItems(db, {
        routineId: routine.id,
        stage: "discovered",
        page: 2,
        pageSize: 5,
      }).items.map((item) => item.id);
    } finally {
      db.close();
    }

    const defaults = (await routes.call(
      "GET",
      "/api/mailarr/routines/:id/pipeline",
      undefined,
      { id: String(routineId) },
    )) as {
      items: Array<{ id: number }>;
      total: number;
      page: number;
      pageSize: number;
      counts: Record<string, number>;
    };

    assert.equal(defaults.page, 1);
    assert.equal(defaults.pageSize, 10);
    assert.equal(defaults.total, 13);
    assert.equal(defaults.items.length, 10);
    assert.equal(defaults.counts.all, 13);
    assert.equal(defaults.counts.discovered, 10);
    assert.equal(defaults.counts.qualified, 3);

    const discoveredPage = (await routes.call(
      "GET",
      "/api/mailarr/routines/:id/pipeline",
      undefined,
      { id: String(routineId) },
      { stage: "discovered", page: "2", page_size: "5" },
    )) as {
      items: Array<{ id: number }>;
      total: number;
      page: number;
      pageSize: number;
    };

    assert.equal(discoveredPage.total, 10);
    assert.equal(discoveredPage.page, 2);
    assert.equal(discoveredPage.pageSize, 5);
    assert.deepEqual(
      discoveredPage.items.map((item) => item.id),
      discoveredPageIds,
    );

    const invalidQueries: Array<Record<string, string>> = [
      { page_size: "15" },
      { page_size: "0" },
      { page_size: "-5" },
      { page: "0" },
      { page: "-1" },
    ];

    for (const query of invalidQueries) {
      const rejected = (await routes.call(
        "GET",
        "/api/mailarr/routines/:id/pipeline",
        undefined,
        { id: String(routineId) },
        query,
      )) as { status: number; body: { error: string } };

      assert.equal(rejected.status, 400);
      assert.match(rejected.body.error, /page/u);
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

test("showing range covers first, partial, and empty pages", () => {
  assert.deepEqual(showingRange(1, 10, 23), { start: 1, end: 10 });
  assert.deepEqual(showingRange(3, 10, 23), { start: 21, end: 23 });
  assert.deepEqual(showingRange(1, 10, 0), { start: 0, end: 0 });
});

test("briefing summary strips markdown and stays on one compact line", () => {
  assert.equal(
    briefingSummary("\n# **Run complete**\n\n- Sent three messages"),
    "Run complete",
  );
  assert.equal(briefingSummary("`code` _review_", 8), "code re…");
  assert.equal(briefingSummary(" \n "), "No briefing content.");
});

test("briefing markdown prefers the host renderer and has a formatted fallback", () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const setWindow = (value: unknown) =>
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      writable: true,
      value,
    });
  const markdown = [
    "# Run complete",
    "",
    "**Bold** and *italic* with `code`.",
    "",
    "- First",
    "- Second",
  ].join("\n");

  try {
    setWindow({});
    const fallback = renderToStaticMarkup(
      createElement(BriefingMarkdown, { markdown }),
    );

    assert.match(fallback, /role="heading"/);
    assert.match(fallback, /<strong>Bold<\/strong>/);
    assert.match(fallback, /<em>italic<\/em>/);
    assert.match(fallback, /<code/);
    assert.match(fallback, /<ul/);

    setWindow({
      __QUBE_SHARED__: {
        ui: {
          MarkdownView: ({ content }: { content: string }) =>
            createElement("article", { "data-host-markdown": "true" }, content),
        },
      },
    });
    const hosted = renderToStaticMarkup(
      createElement(BriefingMarkdown, { markdown }),
    );

    assert.match(hosted, /data-host-markdown="true"/);
    assert.match(hosted, /Run complete/);
  } finally {
    if (originalWindow) {
      Object.defineProperty(globalThis, "window", originalWindow);
    } else {
      Reflect.deleteProperty(globalThis, "window");
    }
  }
});

test("module memory store restores keyed drafts and clears completed state", () => {
  const store = createMemoryStore<{
    name: string;
    reviewedUpdatedAt: string;
  }>();

  store.write("routine:7", {
    name: "Unsaved edit",
    reviewedUpdatedAt: "2030-01-01T00:00:00.000Z",
  });
  store.write("routine:8", {
    name: "Other edit",
    reviewedUpdatedAt: "2030-01-02T00:00:00.000Z",
  });

  assert.deepEqual(store.read("routine:7"), {
    name: "Unsaved edit",
    reviewedUpdatedAt: "2030-01-01T00:00:00.000Z",
  });
  assert.equal(store.read("routine:8")?.name, "Other edit");
  store.remove("routine:7");
  assert.equal(store.read("routine:7"), undefined);
  assert.equal(store.read("routine:8")?.name, "Other edit");
});

test("workbench routing covers center tabs and the in-panel fallback", () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const setWindow = (value: unknown) =>
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      writable: true,
      value,
    });

  try {
    assert.ok(mailarr.editors?.some((editor) => editor.id === "workbench"));
    assert.equal(workbenchTarget({ routineId: 7 }), 7);
    assert.equal(workbenchTarget({ mode: "new" }), "new");
    assert.equal(workbenchTarget({ routineId: 0 }), null);
    assert.equal(workbenchTarget({}), null);
    assert.equal(routineIdFromWorkbenchKey("routine:7"), 7);
    assert.equal(routineIdFromWorkbenchKey("routine:new"), null);
    assert.equal(routineIdFromWorkbenchKey(null), null);

    setWindow({});
    assert.equal(openRoutineWorkbench(11, { id: 7, name: "Scout" }), false);
    assert.equal(openRoutineWorkbench(11, null), false);

    const opened: Array<{ worktreeId: number; spec: unknown }> = [];

    setWindow({
      __QUBE_SHARED__: {
        editorTabs: {
          open: (worktreeId: number, spec: unknown) => {
            opened.push({ worktreeId, spec });
          },
        },
      },
    });

    assert.equal(openRoutineWorkbench(11, { id: 7, name: "Scout" }), true);
    assert.equal(openRoutineWorkbench(11, null), true);
    assert.deepEqual(opened[0], {
      worktreeId: 11,
      spec: {
        ext: "mailarr",
        editor: "workbench",
        key: "routine:7",
        title: "Scout",
        payload: { routineId: 7 },
      },
    });
    assert.deepEqual(opened[1], {
      worktreeId: 11,
      spec: {
        ext: "mailarr",
        editor: "workbench",
        key: "routine:new",
        title: "New routine",
        payload: { mode: "new" },
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
    assert.equal(openRoutineWorkbench(11, { id: 7, name: "Scout" }), false);
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
        "worktree_id",
        "enabled",
        "dry_run",
        "frozen",
        "frozen_at",
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

      const panelOnlyRoutine = createTestRoutine(db, {
        name: "Panel-only dry run",
      });
      const dryRunAttempt = await client.callTool({
        name: "routine_update",
        arguments: { routine_id: panelOnlyRoutine.id, dry_run: false },
      });

      assert.equal(dryRunAttempt.isError, true);
      assert.equal(getRoutine(db, panelOnlyRoutine.id).dryRun, true);
    }, dataDir);
  });
});

test("item_update stores a reviewable draft subject and send subject is optional", async () => {
  await withDatabaseAsync(async (db, dataDir) => {
    const routine = createTestRoutine(db);
    const run = startRun(db, createRun(db, routine.id).id);
    const item = addQualifiedItem(
      db,
      routine.id,
      run.id,
      "Draft Subject Company",
      "draft-subject",
    );

    await withMailarrClient(async (client) => {
      const tools = (await client.listTools()).tools;
      const itemUpdate = tools.find((tool) => tool.name === "item_update");
      const send = tools.find((tool) => tool.name === "send_first_contact");

      assert.ok(itemUpdate);
      assert.match(JSON.stringify(itemUpdate.inputSchema), /draft_subject/);
      assert.ok(send);
      assert.doesNotMatch(
        JSON.stringify((send.inputSchema as { required?: string[] }).required ?? []),
        /subject/,
      );

      const response = await client.callTool({
        name: "item_update",
        arguments: {
          item_id: item.id,
          draft_subject: "Stored review subject",
          draft_pitch: validDraft(routine.requiredDisclosure),
        },
      });

      assert.equal(response.isError, undefined);
    }, dataDir);

    const updated = getItem(db, item.id);

    assert.equal(updated.draftSubject, "Stored review subject");
    assert.equal(updated.draftPitch, validDraft(routine.requiredDisclosure));
  });
});

test("deleteItem removes review drafts and protects ownership and audit history", async () => {
  await withDatabaseAsync(async (db) => {
    const firstRoutine = createTestRoutine(db, { name: "Delete first routine" });
    const secondRoutine = createTestRoutine(db, { name: "Delete second routine" });
    setRoutineFrozen(db, firstRoutine.id, true);
    const run = startRun(db, createRun(db, firstRoutine.id).id);
    const draft = addQualifiedItem(
      db,
      firstRoutine.id,
      run.id,
      "Delete Draft Company",
      "delete-draft",
    );

    updateItem(db, draft.id, {
      draftSubject: "Stored review subject",
      draftPitch: validDraft(firstRoutine.requiredDisclosure),
    });
    assert.throws(
      () => deleteItem(db, secondRoutine.id, draft.id),
      /does not belong to routine/,
    );
    assert.deepEqual(deleteItem(db, firstRoutine.id, draft.id), {
      deleted: true,
      routineId: firstRoutine.id,
      itemId: draft.id,
    });
    assert.throws(() => getItem(db, draft.id), /not found/);

    const dryRun = addQualifiedItem(
      db,
      firstRoutine.id,
      run.id,
      "Dry Run Delete Company",
      "dry-run-delete",
    );

    updateItem(db, dryRun.id, {
      draftSubject: "Dry run subject",
      draftPitch: validDraft(firstRoutine.requiredDisclosure),
    });
    await sendFirstContact({
      db,
      itemId: dryRun.id,
      runId: run.id,
      draft: validDraft(firstRoutine.requiredDisclosure),
      smtp: smtp(),
    });
    assert.equal(getItem(db, dryRun.id).contactedDryRun, true);
    assert.equal(deleteItem(db, firstRoutine.id, dryRun.id).deleted, true);

    const delivered = addQualifiedItem(
      db,
      firstRoutine.id,
      run.id,
      "Delivered Audit Company",
      "delivered-audit",
    );

    updateItem(db, delivered.id, {
      draftSubject: "Delivered subject",
      draftPitch: validDraft(firstRoutine.requiredDisclosure),
    });
    setRoutineDryRun(db, firstRoutine.id, false);
    await sendFirstContact({
      db,
      itemId: delivered.id,
      runId: run.id,
      draft: validDraft(firstRoutine.requiredDisclosure),
      smtp: smtp(),
      deliver: async () => undefined,
    });

    assert.throws(
      () => deleteItem(db, firstRoutine.id, delivered.id),
      /audit history/,
    );
    assert.equal(getItem(db, delivered.id).stage, "contacted");

    const mixedDry = addQualifiedItem(
      db,
      firstRoutine.id,
      run.id,
      "Mixed Audit Company",
      "mixed-audit-dry",
    );
    const mixedReal = addQualifiedItem(
      db,
      firstRoutine.id,
      run.id,
      "Mixed Audit Company",
      "mixed-audit-real",
    );

    for (const item of [mixedDry, mixedReal]) {
      updateItem(db, item.id, {
        draftSubject: "Mixed audit subject",
        draftPitch: validDraft(firstRoutine.requiredDisclosure),
      });
    }
    setRoutineDryRun(db, firstRoutine.id, true);
    await sendFirstContact({
      db,
      itemId: mixedDry.id,
      runId: run.id,
      draft: validDraft(firstRoutine.requiredDisclosure),
      smtp: smtp(),
    });
    setRoutineDryRun(db, firstRoutine.id, false);
    await sendFirstContact({
      db,
      itemId: mixedReal.id,
      runId: run.id,
      draft: validDraft(firstRoutine.requiredDisclosure),
      smtp: smtp(),
      deliver: async () => undefined,
    });

    assert.equal(getItem(db, mixedDry.id).contactedDryRun, true);
    assert.equal(getItem(db, mixedReal.id).contactedDryRun, true);
    assert.throws(
      () => deleteItem(db, firstRoutine.id, mixedReal.id),
      /audit history/,
    );
    assert.throws(
      () => deleteItem(db, firstRoutine.id, mixedDry.id),
      /audit history/,
    );
  });
});

test("freeze stamps review time and refreeze clears edited state", async () => {
  await withPanelRoutes(async (routes, dataDir) => {
    const created = (await routes.call("POST", "/api/mailarr/routines", {
      ...BASE_ROUTINE,
      name: "Informed freeze routine",
    })) as RoutineResponse;
    const routineId = created.routine.id;

    assert.equal(created.routine.frozenAt, null);
    assert.equal(created.routine.editedSinceFreeze, true);

    const firstFreeze = (await routes.call(
      "POST",
      "/api/mailarr/routines/:id/freeze",
      {
        frozen: true,
        reviewedUpdatedAt: created.routine.updatedAt,
      },
      { id: String(routineId) },
    )) as RoutineResponse;

    assert.equal(firstFreeze.routine.frozen, true);
    assert.ok(firstFreeze.routine.frozenAt);
    assert.equal(firstFreeze.routine.editedSinceFreeze, false);
    assert.equal(firstFreeze.routine.updatedAt, firstFreeze.routine.frozenAt);

    const unfrozen = (await routes.call(
      "POST",
      "/api/mailarr/routines/:id/freeze",
      { frozen: false },
      { id: String(routineId) },
    )) as RoutineResponse;

    assert.equal(unfrozen.routine.frozen, false);
    assert.equal(unfrozen.routine.frozenAt, firstFreeze.routine.frozenAt);
    assert.equal(unfrozen.routine.editedSinceFreeze, true);

    await withMailarrClient(async (client) => {
      const response = await client.callTool({
        name: "routine_update",
        arguments: {
          routine_id: routineId,
          order_text: "Agent-edited after review.",
        },
      });

      assert.equal(response.isError, undefined);
    }, dataDir);

    let editedUpdatedAt: string;
    const editedDb = openMailarrDatabase(dataDir);
    try {
      const edited = getRoutine(editedDb, routineId);

      editedUpdatedAt = edited.updatedAt;
      assert.equal(edited.editedSinceFreeze, true);
      assert.ok(edited.updatedAt > unfrozen.routine.updatedAt);
      assert.ok(edited.updatedAt > (edited.frozenAt ?? ""));
    } finally {
      editedDb.close();
    }

    const currentReview = (await routes.call(
      "GET",
      "/api/mailarr/routines/:id",
      undefined,
      { id: String(routineId) },
    )) as {
      routine: {
        orderText: string;
        updatedAt: string;
        editedSinceFreeze: boolean;
      };
    };

    assert.equal(currentReview.routine.orderText, "Agent-edited after review.");
    assert.equal(currentReview.routine.updatedAt, editedUpdatedAt);
    assert.equal(currentReview.routine.editedSinceFreeze, true);

    const staleConfirmation = (await routes.call(
      "POST",
      "/api/mailarr/routines/:id/freeze",
      {
        frozen: true,
        reviewedUpdatedAt: unfrozen.routine.updatedAt,
      },
      { id: String(routineId) },
    )) as { status: number; body: { error: string } };

    assert.equal(staleConfirmation.status, 400);
    assert.match(staleConfirmation.body.error, /review current values/);

    const refrozen = (await routes.call(
      "POST",
      "/api/mailarr/routines/:id/freeze",
      {
        frozen: true,
        reviewedUpdatedAt: currentReview.routine.updatedAt,
      },
      { id: String(routineId) },
    )) as RoutineResponse;

    assert.equal(refrozen.routine.frozen, true);
    assert.ok(
      (refrozen.routine.frozenAt ?? "") >
        (firstFreeze.routine.frozenAt ?? ""),
    );
    assert.equal(refrozen.routine.updatedAt, refrozen.routine.frozenAt);
    assert.equal(refrozen.routine.editedSinceFreeze, false);
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
      dryRun: false,
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
        {
          frozen: true,
          reviewedUpdatedAt: edited.updatedAt,
        },
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

test("agent send uses the routine dry-run flag", async () => {
  await withDatabaseAsync(async (db, dataDir) => {
    const routine = createTestRoutine(db, { name: "Agent dry-run routine" });
    setRoutineFrozen(db, routine.id, true);
    const run = startRun(db, createRun(db, routine.id).id);
    const item = addQualifiedItem(
      db,
      routine.id,
      run.id,
      "Agent Dry Run Company",
      "agent-dry-run",
    );

    updateItem(db, item.id, {
      draftSubject: "Stored agent subject",
      draftPitch: validDraft(routine.requiredDisclosure),
    });

    await withMailarrClient(async (client) => {
      const response = await client.callTool({
        name: "send_first_contact",
        arguments: {
          run_id: run.id,
          item_id: item.id,
          pitch: validDraft(routine.requiredDisclosure),
        },
      });
      const content = response.content as Array<{ type: string; text?: string }>;
      const result = JSON.parse(content[0]?.text ?? "{}") as {
        dryRun: boolean;
      };

      assert.equal(response.isError, undefined);
      assert.equal(result.dryRun, true);
    }, dataDir);

    assert.equal(getItem(db, item.id).contactedDryRun, true);
  });
});

test("panel send uses the stored draft and routine dry-run flag", async () => {
  await withPanelRoutes(async (routes, dataDir) => {
    const db = openMailarrDatabase(dataDir);
    let routineId = 0;
    let itemId = 0;
    let sourceRunId = 0;

    try {
      const routine = createTestRoutine(db, { name: "Panel stored draft" });

      routineId = routine.id;
      setRoutineFrozen(db, routine.id, true);
      const sourceRun = startRun(db, createRun(db, routine.id).id);
      sourceRunId = sourceRun.id;
      const item = addQualifiedItem(
        db,
        routine.id,
        sourceRun.id,
        "Stored Panel Company",
        "stored-panel",
      );

      itemId = item.id;
      updateItem(db, item.id, {
        draftSubject: "Stored panel subject",
        draftPitch: validDraft(routine.requiredDisclosure),
      });
      saveBriefing(
        db,
        sourceRun.id,
        "# Agent briefing\n\nOriginal agent summary.",
      );
    } finally {
      db.close();
    }

    const response = (await routes.call(
      "POST",
      "/api/mailarr/routines/:id/items/:itemId/send",
      {},
      { id: String(routineId), itemId: String(itemId) },
    )) as {
      result: { dryRun: boolean; body: string; sentAt: string };
      run: { id: number; status: string; errorText: string | null };
    };

    assert.equal(response.result.dryRun, true);
    assert.equal(response.run.status, "done");
    assert.equal(response.run.errorText, null);

    const inspected = openMailarrDatabase(dataDir);
    try {
      const item = getItem(inspected, itemId);
      const sent = inspected
        .prepare(
          "SELECT subject, body, dry_run FROM sent_log WHERE run_id = ?",
        )
        .get(response.run.id) as {
        subject: string;
        body: string;
        dry_run: number;
      };
      const briefing = inspected
        .prepare("SELECT markdown_body FROM briefings WHERE run_id = ?")
        .get(response.run.id) as { markdown_body: string };
      const routineBriefing = latestBriefing(inspected, routineId);

      assert.equal(item.stage, "contacted");
      assert.equal(item.runId, response.run.id);
      assert.equal(item.sentSubject, "Stored panel subject");
      assert.equal(item.contactedDryRun, true);
      assert.equal(sent.subject, "Stored panel subject");
      assert.equal(sent.body, response.result.body);
      assert.equal(sent.dry_run, 1);
      assert.equal(
        briefing.markdown_body,
        `${MANUAL_PANEL_BRIEFING_PREFIX} Manual panel send: Stored Panel Company (dry run) ${response.result.sentAt}`,
      );
      assert.equal(routineBriefing?.runId, sourceRunId);
      assert.equal(
        routineBriefing?.markdown,
        "# Agent briefing\n\nOriginal agent summary.",
      );
    } finally {
      inspected.close();
    }
  });
});

test("panel send failures finish manual runs with briefings", async () => {
  await withPanelRoutes(async (routes, dataDir) => {
    const db = openMailarrDatabase(dataDir);
    const targets: Array<{
      routineId: number;
      itemId: number;
      runCountBefore: number;
    }> = [];

    try {
      for (const [name, frozen, draft] of [
        ["Missing Panel Draft", true, false],
        ["Unlocked Panel Draft", false, true],
      ] as const) {
        const routine = createTestRoutine(db, { name });

        if (frozen) setRoutineFrozen(db, routine.id, true);
        const sourceRun = startRun(db, createRun(db, routine.id).id);
        const item = addQualifiedItem(
          db,
          routine.id,
          sourceRun.id,
          `${name} Company`,
          name.toLowerCase().replaceAll(" ", "-"),
        );

        if (draft) {
          updateItem(db, item.id, {
            draftSubject: "Stored panel subject",
            draftPitch: validDraft(routine.requiredDisclosure),
          });
        }
        const runCount = db
          .prepare("SELECT COUNT(*) AS count FROM runs WHERE routine_id = ?")
          .get(routine.id) as { count: number };

        targets.push({
          routineId: routine.id,
          itemId: item.id,
          runCountBefore: Number(runCount.count),
        });
      }
    } finally {
      db.close();
    }

    for (const [index, target] of targets.entries()) {
      const response = (await routes.call(
        "POST",
        "/api/mailarr/routines/:id/items/:itemId/send",
        {},
        { id: String(target.routineId), itemId: String(target.itemId) },
      )) as { status: number; body: { error: string } };

      assert.equal(response.status, 400);
      assert.match(
        response.body.error,
        index === 0 ? /no stored draft/ : /routine is unlocked for editing/,
      );

      const inspected = openMailarrDatabase(dataDir);
      try {
        const runCount = inspected
          .prepare("SELECT COUNT(*) AS count FROM runs WHERE routine_id = ?")
          .get(target.routineId) as { count: number };
        const run = inspected
          .prepare(
            "SELECT id, status, error_text FROM runs WHERE routine_id = ? ORDER BY id DESC LIMIT 1",
          )
          .get(target.routineId) as {
          id: number;
          status: string;
          error_text: string | null;
        };

        if (index === 1) {
          const briefingCount = inspected
            .prepare(`
              SELECT COUNT(*) AS count
              FROM briefings
              JOIN runs ON runs.id = briefings.run_id
              WHERE runs.routine_id = ?
            `)
            .get(target.routineId) as { count: number };

          assert.equal(Number(runCount.count), target.runCountBefore);
          assert.equal(run.status, "running");
          assert.equal(run.error_text, null);
          assert.equal(Number(briefingCount.count), 0);
          continue;
        }

        const briefing = inspected
          .prepare("SELECT markdown_body FROM briefings WHERE run_id = ?")
          .get(run.id) as { markdown_body: string };

        assert.equal(Number(runCount.count), target.runCountBefore + 1);
        assert.equal(run.status, "failed");
        assert.equal(run.error_text, response.body.error);
        assert.match(
          briefing.markdown_body,
          /^\[mailarr:manual-panel-send\] Manual panel send failed:/,
        );
        assert.match(briefing.markdown_body, new RegExp(response.body.error));
      } finally {
        inspected.close();
      }
    }
  });
});

test("panel send surfaces cap and dedupe guards in failed manual runs", async () => {
  await withPanelRoutes(async (routes, dataDir) => {
    const db = openMailarrDatabase(dataDir);
    let capRoutineId = 0;
    let capFirstId = 0;
    let capSecondId = 0;
    let dedupeRoutineId = 0;
    let duplicateId = 0;

    try {
      const capped = createTestRoutine(db, {
        name: "Panel capped routine",
        dailyCap: 1,
      });

      capRoutineId = capped.id;
      setRoutineFrozen(db, capped.id, true);
      const capSourceRun = startRun(db, createRun(db, capped.id).id);
      const capFirst = addQualifiedItem(
        db,
        capped.id,
        capSourceRun.id,
        "Panel Cap First",
        "panel-cap-first",
      );
      const capSecond = addQualifiedItem(
        db,
        capped.id,
        capSourceRun.id,
        "Panel Cap Second",
        "panel-cap-second",
      );

      capFirstId = capFirst.id;
      capSecondId = capSecond.id;
      for (const item of [capFirst, capSecond]) {
        updateItem(db, item.id, {
          draftSubject: "Stored panel subject",
          draftPitch: validDraft(capped.requiredDisclosure),
        });
      }

      const dedupe = createTestRoutine(db, {
        name: "Panel dedupe routine",
        dryRun: false,
      });

      dedupeRoutineId = dedupe.id;
      setRoutineFrozen(db, dedupe.id, true);
      const dedupeSourceRun = startRun(db, createRun(db, dedupe.id).id);
      const delivered = addQualifiedItem(
        db,
        dedupe.id,
        dedupeSourceRun.id,
        "Panel Duplicate Company",
        "panel-duplicate-first",
      );

      updateItem(db, delivered.id, {
        draftSubject: "Stored panel subject",
        draftPitch: validDraft(dedupe.requiredDisclosure),
      });
      await sendFirstContact({
        db,
        itemId: delivered.id,
        runId: dedupeSourceRun.id,
        draft: validDraft(dedupe.requiredDisclosure),
        smtp: smtp(),
        deliver: async () => undefined,
      });
      const duplicate = addQualifiedItem(
        db,
        dedupe.id,
        dedupeSourceRun.id,
        "Panel Duplicate Company",
        "panel-duplicate-second",
      );

      duplicateId = duplicate.id;
      updateItem(db, duplicate.id, {
        draftSubject: "Stored panel subject",
        draftPitch: validDraft(dedupe.requiredDisclosure),
      });
    } finally {
      db.close();
    }

    const callSend = (routineId: number, itemId: number) =>
      routes.call(
        "POST",
        "/api/mailarr/routines/:id/items/:itemId/send",
        {},
        { id: String(routineId), itemId: String(itemId) },
      );

    await callSend(capRoutineId, capFirstId);
    const capError = (await callSend(capRoutineId, capSecondId)) as {
      status: number;
      body: { error: string };
    };
    const dedupeError = (await callSend(dedupeRoutineId, duplicateId)) as {
      status: number;
      body: { error: string };
    };

    assert.equal(capError.status, 400);
    assert.match(capError.body.error, /Daily cap of 1 reached/);
    assert.equal(dedupeError.status, 400);
    assert.match(dedupeError.body.error, /already been contacted/);

    const inspected = openMailarrDatabase(dataDir);
    try {
      for (const [routineId, expected] of [
        [capRoutineId, capError.body.error],
        [dedupeRoutineId, dedupeError.body.error],
      ] as const) {
        const failed = inspected
          .prepare(
            "SELECT id, status, error_text FROM runs WHERE routine_id = ? ORDER BY id DESC LIMIT 1",
          )
          .get(routineId) as {
          id: number;
          status: string;
          error_text: string;
        };
        const briefing = inspected
          .prepare("SELECT markdown_body FROM briefings WHERE run_id = ?")
          .get(failed.id) as { markdown_body: string };

        assert.equal(failed.status, "failed");
        assert.equal(failed.error_text, expected);
        assert.match(briefing.markdown_body, new RegExp(expected));
      }
    } finally {
      inspected.close();
    }
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

test("send defaults to the reviewed draft subject and explicit subject overrides", async () => {
  await withDatabaseAsync(async (db) => {
    const routine = createTestRoutine(db, { dryRun: false });
    setRoutineFrozen(db, routine.id, true);
    const run = startRun(db, createRun(db, routine.id).id);
    const storedItem = addQualifiedItem(
      db,
      routine.id,
      run.id,
      "Stored Subject Company",
      "stored-subject",
    );
    const overrideItem = addQualifiedItem(
      db,
      routine.id,
      run.id,
      "Override Subject Company",
      "override-subject",
    );
    const deliveredSubjects: string[] = [];

    updateItem(db, storedItem.id, { draftSubject: "Stored subject 2" });
    updateItem(db, overrideItem.id, { draftSubject: "Ignored stored subject" });

    await assert.rejects(
      sendFirstContact({
        db,
        itemId: storedItem.id,
        runId: run.id,
        to: storedItem.contactEmail ?? "",
        draft: validDraft(routine.requiredDisclosure),
        smtp: smtp(),
      }),
      /numeric characters/,
    );
    updateItem(db, storedItem.id, { draftSubject: "Stored review subject" });

    await sendFirstContact({
      db,
      itemId: storedItem.id,
      runId: run.id,
      to: storedItem.contactEmail ?? "",
      draft: validDraft(routine.requiredDisclosure),
      smtp: smtp(),
      deliver: async ({ subject }) => {
        deliveredSubjects.push(subject);
      },
    });
    await sendFirstContact({
      db,
      itemId: overrideItem.id,
      runId: run.id,
      to: overrideItem.contactEmail ?? "",
      subject: "Explicit subject",
      draft: validDraft(routine.requiredDisclosure),
      smtp: smtp(),
      deliver: async ({ subject }) => {
        deliveredSubjects.push(subject);
      },
    });

    assert.deepEqual(deliveredSubjects, [
      "Stored review subject",
      "Explicit subject",
    ]);
    assert.equal(getItem(db, storedItem.id).sentSubject, "Stored review subject");
    assert.equal(getItem(db, overrideItem.id).sentSubject, "Explicit subject");
  });
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
      now: new Date("2030-01-02T01:00:00.000Z"),
      deliver: async () => {
        deliveries += 1;
      },
    });

    assert.equal(result.dryRun, true);
    assert.equal(deliveries, 0);
    assert.equal(hasSentCompany(db, item.company), false);
    updateItem(db, item.id, { stage: "qualified" });
    setRoutineDryRun(db, routine.id, false);

    await assert.rejects(
      sendFirstContact({
        db,
        itemId: item.id,
        runId: run.id,
        to: item.contactEmail ?? "",
        subject: "Hello again",
        draft: validDraft(routine.requiredDisclosure),
        smtp: smtp(),
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
    const routine = createTestRoutine(db, { dryRun: false });
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
        config: {
          dry_run: false,
          smtp_host: "smtp.example.test",
          smtp_port: 465,
          from_address: "sender@example.test",
        },
        secrets: {
          get: async (key: string) =>
            key === "smtp_user"
              ? "user"
              : key === "smtp_password"
                ? "secret"
                : null,
        },
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
    worktreeId: number | null;
    dryRun: boolean;
    frozen: boolean;
    frozenAt: string | null;
    editedSinceFreeze: boolean;
    updatedAt: string;
  };
}

interface RunDeliveryRouteResponse {
  run: { id: number };
  delivery: "nudged" | "queued" | "polling fallback";
  refusal?: string;
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
        query?: Record<string, string>,
      ) => Promise<unknown>;
    },
    dataDir: string,
  ) => Promise<void>,
  ctxOverrides: Partial<ExtensionContext> = {},
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
    config: {
      dry_run: false,
      smtp_host: "smtp.example.test",
      smtp_port: 465,
      from_address: "sender@example.test",
    },
    secrets: {
      get: async (key: string) =>
        key === "smtp_user" ? "user" : key === "smtp_password" ? "secret" : null,
    },
    broadcast: () => undefined,
    notifyAgent: async () => ({ ok: true, queued: false }),
    ...ctxOverrides,
  } as unknown as ExtensionContext;

  registerMailarrRoutes(app, () => ctx);

  try {
    await action(
      {
        call: async (method, path, body, params = {}, query = {}) => {
          const handler = handlers.get(`${method} ${path}`);

          assert.ok(handler, `route not registered: ${method} ${path}`);

          return handler(
            { body, params, query },
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
