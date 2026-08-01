import type {
  Extension,
  ExtensionContext,
  RouteRequest,
} from "@qube-code/extension-sdk";
import {
  cancelPendingRuns,
  createRoutine,
  createRun,
  deleteItem,
  finishRun,
  getItem,
  getRoutine,
  latestBriefing,
  listItems,
  listSources,
  MANUAL_PANEL_BRIEFING_PREFIX,
  openMailarrDatabase,
  pipelineCounts,
  routineDashboard,
  saveBriefing,
  type RoutineInput,
  setRoutineEnabled,
  setRoutineFrozen,
  startRun,
  updateRoutine,
} from "./lib/db.js";
import { ITEM_STAGES, type ItemStage } from "./lib/model.js";
import { notifyPendingRun } from "./lib/scheduler.js";
import { requireFrozenRoutine, sendFirstContact } from "./lib/send.js";
import { dryRunEnabled } from "./mcp.js";

type RegisterRoutes = NonNullable<Extension["registerRoutes"]>;
type ExtensionApp = Parameters<RegisterRoutes>[0];
type ContextResolver = Parameters<RegisterRoutes>[1];

export function registerMailarrRoutes(
  app: ExtensionApp,
  getCtx: ContextResolver,
): void {
  app.get("/api/mailarr/routines", async (req, reply) =>
    useDb(req, reply, getCtx, (db) => ({ routines: routineDashboard(db) })),
  );

  app.get<{ Params: { id: string } }>(
    "/api/mailarr/routines/:id",
    async (req, reply) =>
      useDb(req, reply, getCtx, (db) => ({
        routine: getRoutine(db, positiveInt(req.params.id, "routine id")),
      })),
  );

  app.post("/api/mailarr/routines", async (req, reply) =>
    useDb(req, reply, getCtx, (db, ctx) => {
      const routine = createRoutine(db, routineInput(req.body));

      ctx.broadcast({ type: "mailarr-changed" });

      return { routine };
    }),
  );

  app.put<{ Params: { id: string } }>(
    "/api/mailarr/routines/:id",
    async (req, reply) =>
      useDb(req, reply, getCtx, (db, ctx) => {
        const routineId = positiveInt(req.params.id, "routine id");
        const body = record(req.body);
        const current = getRoutine(db, routineId);
        const reviewedUpdatedAt = string(
          body.reviewedUpdatedAt,
          "reviewed updated time",
        );

        if (current.updatedAt !== reviewedUpdatedAt) {
          throw new Error(
            "routine changed after this form was loaded; reload current values and retry",
          );
        }

        const routine = updateRoutine(
          db,
          routineId,
          routineInput(body),
        );

        ctx.broadcast({ type: "mailarr-changed" });

        return { routine };
      }),
  );

  app.post<{ Params: { id: string } }>(
    "/api/mailarr/routines/:id/toggle",
    async (req, reply) =>
      useDb(req, reply, getCtx, (db, ctx) => {
        const body = record(req.body);
        const routine = setRoutineEnabled(
          db,
          positiveInt(req.params.id, "routine id"),
          Boolean(body.enabled),
        );

        ctx.broadcast({ type: "mailarr-changed" });

        return { routine };
      }),
  );

  app.post<{ Params: { id: string } }>(
    "/api/mailarr/routines/:id/freeze",
    async (req, reply) =>
      useDb(req, reply, getCtx, (db, ctx) => {
        const body = record(req.body);
        const routineId = positiveInt(req.params.id, "routine id");
        const frozen = boolean(body.frozen, "frozen");

        if (frozen) {
          const current = getRoutine(db, routineId);
          const reviewedUpdatedAt = string(
            body.reviewedUpdatedAt,
            "reviewed updated time",
          );

          if (current.updatedAt !== reviewedUpdatedAt) {
            throw new Error(
              "routine content changed after review; review current values before freezing",
            );
          }
        }

        const routine = setRoutineFrozen(db, routineId, frozen);

        ctx.broadcast({ type: "mailarr-changed" });

        return { routine };
      }),
  );

  app.post<{ Params: { id: string } }>(
    "/api/mailarr/routines/:id/run",
    async (req, reply) =>
      useDb(req, reply, getCtx, (db, ctx) => {
        const routineId = positiveInt(req.params.id, "routine id");
        const routine = getRoutine(db, routineId);
        const run = createRun(db, routineId);

        ctx.broadcast({ type: "mailarr-changed" });

        return notifyPendingRun(ctx, routine, run).then((outcome) => ({
          run,
          ...outcome,
        }));
      }),
  );

  app.post<{ Params: { id: string } }>(
    "/api/mailarr/routines/:id/cancel-pending",
    async (req, reply) =>
      useDb(req, reply, getCtx, (db, ctx) => {
        const body = record(req.body);
        const runs = cancelPendingRuns(
          db,
          positiveInt(req.params.id, "routine id"),
          optionalBoolean(body.all, "all") ?? false,
        );

        ctx.broadcast({ type: "mailarr-changed" });

        return { run: runs[0], runs, cancelled: runs.length };
      }),
  );

  app.post<{ Params: { id: string; itemId: string } }>(
    "/api/mailarr/routines/:id/items/:itemId/delete",
    async (req, reply) =>
      useDb(req, reply, getCtx, (db, ctx) => {
        const deleted = deleteItem(
          db,
          positiveInt(req.params.id, "routine id"),
          positiveInt(req.params.itemId, "item id"),
        );

        ctx.broadcast({ type: "mailarr-changed" });

        return deleted;
      }),
  );

  app.post<{ Params: { id: string; itemId: string } }>(
    "/api/mailarr/routines/:id/items/:itemId/send",
    async (req, reply) =>
      useDb(req, reply, getCtx, async (db, ctx) => {
        const routineId = positiveInt(req.params.id, "routine id");
        const itemId = positiveInt(req.params.itemId, "item id");
        const item = getItem(db, itemId);

        if (item.routineId !== routineId) {
          throw new Error(
            `item ${itemId} does not belong to routine ${routineId}`,
          );
        }
        if (!getRoutine(db, routineId).frozen) {
          throw new Error(
            "routine is unlocked for editing; freeze it in the panel to enable sends",
          );
        }

        const run = startRun(db, createRun(db, routineId).id);

        try {
          if (!item.draftPitch) {
            throw new Error(`item ${itemId} has no stored draft`);
          }

          requireFrozenRoutine(db, run.id);
          const [smtpUser, smtpPassword] = await Promise.all([
            ctx.secrets.get("smtp_user"),
            ctx.secrets.get("smtp_password"),
          ]);
          const result = await sendFirstContact({
            db,
            runId: run.id,
            itemId,
            draft: item.draftPitch,
            smtp: {
              host: configString(ctx.config, "smtp_host"),
              port: configPort(ctx.config),
              user: smtpUser ?? "",
              password: smtpPassword ?? "",
              fromAddress: configString(ctx.config, "from_address"),
            },
            dryRun: dryRunEnabled(ctx.config),
          });
          saveBriefing(
            db,
            run.id,
            `${MANUAL_PANEL_BRIEFING_PREFIX} Manual panel send: ${item.company} (${
              result.dryRun ? "dry run" : "delivered"
            }) ${result.sentAt}`,
          );
          const finished = finishRun(db, run.id, "done");

          ctx.broadcast({ type: "mailarr-changed" });

          return { result, run: finished };
        } catch (error) {
          const errorText = message(error);

          saveBriefing(
            db,
            run.id,
            `${MANUAL_PANEL_BRIEFING_PREFIX} Manual panel send failed: ${
              item.company
            } ${new Date().toISOString()}: ${errorText}`,
          );
          finishRun(db, run.id, "failed", errorText);
          ctx.broadcast({ type: "mailarr-changed" });

          throw error;
        }
      }),
  );

  app.get<{
    Params: { id: string };
    Querystring: { stage?: string; page?: string; page_size?: string };
  }>(
    "/api/mailarr/routines/:id/pipeline",
    async (req, reply) =>
      useDb(req, reply, getCtx, (db, ctx) => {
        const routineId = positiveInt(req.params.id, "routine id");
        const stage = parseStage(req.query.stage);
        const page = positiveInt(req.query.page ?? 1, "page");
        const pageSize = pipelinePageSize(req.query.page_size);
        const { items, total } = listItems(db, {
          routineId,
          stage,
          page,
          pageSize,
        });

        const routine = routineDashboard(db).find(
          (entry) => entry.id === routineId,
        );

        if (!routine) throw new Error(`routine ${routineId} not found`);

        return {
          routine,
          sources: listSources(db, routineId),
          counts: pipelineCounts(db, routineId),
          briefing: latestBriefing(db, routineId),
          dryRun: dryRunEnabled(ctx.config),
          items,
          total,
          page,
          pageSize,
        };
      }),
  );
}

async function useDb<T>(
  req: RouteRequest,
  reply: { code: (status: number) => { send: (body: unknown) => unknown } },
  getCtx: ContextResolver,
  action: (
    db: ReturnType<typeof openMailarrDatabase>,
    ctx: ExtensionContext,
  ) => T | Promise<T>,
): Promise<T | unknown> {
  const ctx = getCtx(req);

  if (!ctx) return reply.code(409).send({ error: "no project open" });

  let db: ReturnType<typeof openMailarrDatabase> | undefined;

  try {
    db = openMailarrDatabase(ctx.dataDir);

    return await action(db, ctx);
  } catch (error) {
    return reply.code(400).send({ error: message(error) });
  } finally {
    db?.close();
  }
}

function routineInput(value: unknown): RoutineInput {
  const body = record(value);
  const keywords = keywordMap(body.keywords);
  const scoreFloor = nullableInteger(body.scoreFloor, "score floor");

  return {
    name: string(body.name, "name"),
    cron: string(body.cron, "cron"),
    orderText: string(body.orderText, "order"),
    session: nullableString(body.session),
    sessionLabel: nullableString(body.sessionLabel),
    worktreeId: nullablePositiveInteger(body.worktreeId, "nudge worktree"),
    dailyCap: positiveInt(body.dailyCap, "daily cap"),
    verbatimTerms: string(body.verbatimTerms, "verbatim terms", false),
    blockedTopics: stringArray(body.blockedTopics, "blocked topics"),
    requiredDisclosure: nullableString(body.requiredDisclosure),
    keywords,
    scoreFloor,
  };
}

function keywordMap(value: unknown): Record<string, number> | null {
  if (value === null || value === undefined) return null;
  const map = record(value);

  for (const [term, weight] of Object.entries(map)) {
    if (!term.trim() || typeof weight !== "number" || !Number.isFinite(weight)) {
      throw new Error("keywords must map non-empty terms to numeric weights");
    }
  }

  return map as Record<string, number>;
}

function stringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error(`${field} must be a string array`);
  }

  return value;
}

function nullableString(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string") throw new Error("value must be a string or null");

  return value.trim() || null;
}

function nullableInteger(value: unknown, field: string): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);

  if (!Number.isInteger(parsed)) throw new Error(`${field} must be an integer or null`);

  return parsed;
}

function nullablePositiveInteger(value: unknown, field: string): number | null {
  const parsed = nullableInteger(value, field);

  if (parsed !== null && parsed <= 0) {
    throw new Error(`${field} must be a positive integer or null`);
  }

  return parsed;
}

function boolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${field} must be a boolean`);

  return value;
}

function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined;

  return boolean(value, field);
}

function parseStage(value: unknown): ItemStage | undefined {
  if (value === undefined || value === "" || value === "all") return undefined;
  if (!ITEM_STAGES.includes(value as ItemStage)) throw new Error("invalid item stage");

  return value as ItemStage;
}

function pipelinePageSize(value: unknown): 5 | 10 | 20 {
  if (value === undefined) return 10;
  const parsed = Number(value);

  if (parsed !== 5 && parsed !== 10 && parsed !== 20) {
    throw new Error("page size must be 5, 10, or 20");
  }

  return parsed;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("request body must be an object");
  }

  return value as Record<string, unknown>;
}

function string(
  value: unknown,
  field: string,
  trim = true,
): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${field} is required`);
  }

  return trim ? value.trim() : value;
}

function positiveInt(value: unknown, field: string): number {
  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${field} must be a positive integer`);
  }

  return parsed;
}

function configString(config: Record<string, unknown>, key: string): string {
  const value = config[key];

  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function configPort(config: Record<string, unknown>): number {
  const value = Number(config.smtp_port);

  return Number.isInteger(value) ? value : 0;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
