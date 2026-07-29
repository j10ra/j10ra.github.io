import type { ExtensionContext } from "@qube-code/extension-sdk";
import { createRun, listEnabledRoutines, openMailarrDatabase } from "./db.js";
import { cronMatches, localMinuteKey } from "./cron.js";

const timers = new Map<string, NodeJS.Timeout>();

export const SCHEDULER_DELIVERY = "polling fallback" as const;

export function startScheduler(ctx: ExtensionContext): void {
  stopScheduler(ctx);

  const tick = () => {
    const db = openMailarrDatabase(ctx.dataDir);
    const now = new Date();
    const scheduledFor = localMinuteKey(now);

    try {
      let changed = false;

      for (const routine of listEnabledRoutines(db)) {
        try {
          if (!cronMatches(routine.cron, now)) continue;

          createRun(db, routine.id, scheduledFor);
          changed = true;
        } catch (error) {
          console.error(`[mailarr] scheduler skipped ${routine.name}: ${message(error)}`);
        }
      }

      if (changed) ctx.broadcast({ type: "mailarr-changed" });
    } finally {
      db.close();
    }
  };

  tick();
  const timer = setInterval(tick, 60_000);
  timer.unref();
  timers.set(ctx.dataDir, timer);
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
