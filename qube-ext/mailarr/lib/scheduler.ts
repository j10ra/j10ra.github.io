import type {
  ExtensionContext,
  NotifyAgentRefusal,
} from "@qube-code/extension-sdk";
import { createRun, listEnabledRoutines, openMailarrDatabase } from "./db.js";
import { cronMatches, localMinuteKey } from "./cron.js";
import type { Routine, Run } from "./model.js";

const timers = new Map<string, NodeJS.Timeout>();

export type RunDeliveryOutcome =
  | { delivery: "nudged" | "queued" }
  | { delivery: "polling fallback"; refusal?: NotifyAgentRefusal };

export async function notifyPendingRun(
  ctx: ExtensionContext,
  routine: Pick<Routine, "id" | "name" | "worktreeId">,
  run: Pick<Run, "id">,
): Promise<RunDeliveryOutcome> {
  if (routine.worktreeId === null) return { delivery: "polling fallback" };

  try {
    const result = await ctx.notifyAgent({
      worktreeId: routine.worktreeId,
      text: `[mailarr] Routine ${routine.name} (id ${routine.id}) has pending run ${run.id}. Execute the Mailarr run protocol from the sebe skill.`,
      nudgeId: `mailarr-run-${run.id}`,
    });

    if (result.ok) {
      return { delivery: result.queued ? "queued" : "nudged" };
    }

    console.error(
      `[mailarr] nudge refused for run ${run.id}: ${result.refused}; agent will poll`,
    );

    return { delivery: "polling fallback", refusal: result.refused };
  } catch (error) {
    console.error(
      `[mailarr] nudge failed for run ${run.id}: ${message(error)}; agent will poll`,
    );

    return { delivery: "polling fallback", refusal: "delivery-failed" };
  }
}

export function startScheduler(ctx: ExtensionContext): void {
  stopScheduler(ctx);

  const tick = () => {
    void runSchedulerTick(ctx).catch((error) => {
      console.error(`[mailarr] scheduler tick failed: ${message(error)}`);
    });
  };

  tick();
  const timer = setInterval(tick, 60_000);
  timer.unref();
  timers.set(ctx.dataDir, timer);
}

export async function runSchedulerTick(
  ctx: ExtensionContext,
  now = new Date(),
): Promise<void> {
  const db = openMailarrDatabase(ctx.dataDir);
  const scheduledFor = localMinuteKey(now);

  try {
    let changed = false;

    for (const routine of listEnabledRoutines(db)) {
      try {
        if (!cronMatches(routine.cron, now)) continue;

        const run = createRun(db, routine.id, scheduledFor);

        changed = true;
        await notifyPendingRun(ctx, routine, run);
      } catch (error) {
        console.error(`[mailarr] scheduler skipped ${routine.name}: ${message(error)}`);
      }
    }

    if (changed) ctx.broadcast({ type: "mailarr-changed" });
  } finally {
    db.close();
  }
}

export function stopScheduler(ctx?: ExtensionContext): void {
  if (!ctx) {
    for (const timer of timers.values()) clearInterval(timer);
    timers.clear();

    return;
  }

  const timer = timers.get(ctx.dataDir);

  if (timer) clearInterval(timer);
  timers.delete(ctx.dataDir);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
