import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionContext } from "@qube-code/extension-sdk";
import {
  createRoutine,
  listPendingRuns,
  openMailarrDatabase,
  setRoutineEnabled,
  type RoutineInput,
} from "../lib/db.js";
import { runSchedulerTick } from "../lib/scheduler.js";

const SCHEDULED_AT = new Date(2026, 6, 29, 9, 0, 0);
const ROUTINE: RoutineInput = {
  name: "Scheduled delivery",
  cron: "0 9 * * *",
  orderText: "Run the scheduled outreach.",
  session: null,
  sessionLabel: null,
  worktreeId: null,
  dailyCap: 5,
  verbatimTerms: "Availability: 20 hours per week.",
  blockedTopics: [],
  requiredDisclosure: "I am an AI assistant.",
  keywords: null,
  scoreFloor: null,
};

test("scheduler nudges the configured worktree with an idempotent run payload", async () => {
  await withScheduler(async (dataDir) => {
    const calls: Array<{
      worktreeId: number;
      text: string;
      nudgeId?: string;
    }> = [];
    const ctx = schedulerContext(dataDir, async (input) => {
      calls.push(input);

      return { ok: true, queued: false };
    });
    const routine = createEnabledRoutine(dataDir, { worktreeId: 73088147 });

    await runSchedulerTick(ctx, SCHEDULED_AT);

    const run = pendingRuns(dataDir)[0];

    assert.ok(run);
    assert.deepEqual(calls, [
      {
        worktreeId: 73088147,
        text: `[mailarr] Routine ${routine.name} (id ${routine.id}) has pending run ${run.id}. Execute the Mailarr run protocol from the sebe skill.`,
        nudgeId: `mailarr-run-${run.id}`,
      },
    ]);
  });
});

test("scheduler skips agent delivery when the routine has no nudge worktree", async () => {
  await withScheduler(async (dataDir) => {
    let calls = 0;
    const ctx = schedulerContext(dataDir, async () => {
      calls += 1;

      return { ok: true, queued: false };
    });

    createEnabledRoutine(dataDir);
    await runSchedulerTick(ctx, SCHEDULED_AT);

    assert.equal(calls, 0);
    assert.equal(pendingRuns(dataDir).length, 1);
  });
});

test("scheduler preserves pending runs when nudges are refused or throw", async () => {
  for (const behavior of ["refused", "throws"] as const) {
    await withScheduler(async (dataDir) => {
      const logs: string[] = [];
      const originalError = console.error;
      const ctx = schedulerContext(dataDir, async () => {
        if (behavior === "throws") throw new Error("transport unavailable");

        return { ok: false, refused: "rate-limited" };
      });

      createEnabledRoutine(dataDir, { worktreeId: 73088147 });
      console.error = (...values: unknown[]) => {
        logs.push(values.map(String).join(" "));
      };

      try {
        await runSchedulerTick(ctx, SCHEDULED_AT);
      } finally {
        console.error = originalError;
      }

      assert.equal(pendingRuns(dataDir).length, 1);
      assert.equal(logs.length, 1);
      assert.match(logs[0], behavior === "throws" ? /transport unavailable/ : /rate-limited/);
    });
  }
});

function schedulerContext(
  dataDir: string,
  notifyAgent: ExtensionContext["notifyAgent"],
): ExtensionContext {
  return {
    dataDir,
    notifyAgent,
    broadcast: () => undefined,
  } as unknown as ExtensionContext;
}

function createEnabledRoutine(
  dataDir: string,
  overrides: Partial<RoutineInput> = {},
) {
  const db = openMailarrDatabase(dataDir);

  try {
    const routine = createRoutine(db, { ...ROUTINE, ...overrides });

    return setRoutineEnabled(db, routine.id, true);
  } finally {
    db.close();
  }
}

function pendingRuns(dataDir: string) {
  const db = openMailarrDatabase(dataDir);

  try {
    return listPendingRuns(db);
  } finally {
    db.close();
  }
}

async function withScheduler(
  action: (dataDir: string) => Promise<void>,
): Promise<void> {
  const dataDir = mkdtempSync(join(tmpdir(), "mailarr-scheduler-test-"));

  try {
    await action(dataDir);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
}
