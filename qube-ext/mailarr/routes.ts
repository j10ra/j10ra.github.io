import type {
  Extension,
  ExtensionContext,
  RouteRequest,
} from "@qube-code/extension-sdk";
import {
  createRoutine,
  createRun,
  getRoutine,
  latestBriefing,
  listItems,
  listSources,
  openMailarrDatabase,
  pipelineCounts,
  routineDashboard,
  type RoutineInput,
  setRoutineEnabled,
  updateRoutine,
} from "./lib/db.js";
import { ITEM_STAGES, type ItemStage } from "./lib/model.js";

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
        const routine = updateRoutine(
          db,
          positiveInt(req.params.id, "routine id"),
          routineInput(req.body),
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
    "/api/mailarr/routines/:id/run",
    async (req, reply) =>
      useDb(req, reply, getCtx, (db, ctx) => {
        const routineId = positiveInt(req.params.id, "routine id");
        getRoutine(db, routineId);
        const run = createRun(db, routineId);

        ctx.broadcast({ type: "mailarr-changed" });

        return { run, delivery: "polling fallback" };
      }),
  );

  app.get<{ Params: { id: string }; Querystring: { stage?: string } }>(
    "/api/mailarr/routines/:id/pipeline",
    async (req, reply) =>
      useDb(req, reply, getCtx, (db) => {
        const routineId = positiveInt(req.params.id, "routine id");
        const stage = parseStage(req.query.stage);
        const items = listItems(db, {
          routineId,
          stage,
          page: 1,
          pageSize: 500,
        }).items;

        return {
          routine: getRoutine(db, routineId),
          sources: listSources(db, routineId),
          counts: pipelineCounts(db, routineId),
          briefing: latestBriefing(db, routineId),
          items,
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
  const scoreFloor =
    keywords === null ? null : nullableInteger(body.scoreFloor, "score floor");

  return {
    name: string(body.name, "name"),
    cron: string(body.cron, "cron"),
    orderText: string(body.orderText, "order"),
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

function parseStage(value: unknown): ItemStage | undefined {
  if (value === undefined || value === "" || value === "all") return undefined;
  if (!ITEM_STAGES.includes(value as ItemStage)) throw new Error("invalid item stage");

  return value as ItemStage;
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

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
