import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ExtensionContext } from "@qube-code/extension-sdk";
import { z } from "zod";
import {
  addSource,
  finishRun,
  getRoutine,
  listItems,
  listPendingRuns,
  listSources,
  openMailarrDatabase,
  removeSource,
  saveBriefing,
  startRun,
  updateItem,
  updateRoutineContent,
  updateSource,
} from "./lib/db.js";
import { addItems } from "./lib/intake.js";
import { ITEM_STAGES, SOURCE_STATUSES } from "./lib/model.js";
import { requireFrozenRoutine, sendFirstContact } from "./lib/send.js";

const text = (value: unknown) => ({
  content: [
    {
      type: "text" as const,
      text: typeof value === "string" ? value : JSON.stringify(value, null, 2),
    },
  ],
});
const fail = (error: unknown) => ({
  content: [{ type: "text" as const, text: `Error: ${message(error)}` }],
  isError: true,
});

export const MAILARR_INSTRUCTIONS = [
  "# Mailarr",
  "",
  "Mailarr is a generic guarded first-contact mailer. On a scheduler nudge, or when polling:",
  "",
  "1. Call routines_due.",
  "2. For each pending run, call routine_get and follow its order_text.",
  "3. Call run_start.",
  "4. Manage routine sources when the order requests it, then fetch them yourself.",
  "5. Submit fetched contacts with items_add.",
  "6. Page through items_list and qualify with item_update.",
  "7. Store one draft subject and body per qualified contact with item_update, using the routine disclosure and {{TERMS}} once.",
  "8. Call send_first_contact until the routine cap is reached.",
  "9. Call post_briefing, then run_finish.",
  "",
  "Routine content can be updated only while unlocked. Sending requires the user to freeze",
  "the routine in the panel.",
  "",
  "The send tool is the only mail egress. It inserts routine-owned terms verbatim and enforces",
  "content validation, recipient matching, the daily cap, permanent company dedupe, and dry-run mode.",
].join("\n");

export function mailarrMcpServer(ctx: () => ExtensionContext): McpServer {
  const server = new McpServer(
    { name: "mailarr", version: "0.1.0" },
    { instructions: MAILARR_INSTRUCTIONS },
  );

  server.registerTool(
    "routines_due",
    { description: "List routines with pending runs." },
    () => withDb(ctx, (db) => listPendingRuns(db)),
  );

  server.registerTool(
    "routine_get",
    {
      description:
        "Read a routine's order, cap, terms, validation content, scoring rules, and sources.",
      inputSchema: { routine_id: z.number().int().positive() },
    },
    ({ routine_id }) =>
      withDb(ctx, (db) => ({
        ...getRoutine(db, routine_id),
        sources: listSources(db, routine_id),
      })),
  );

  server.registerTool(
    "routine_update",
    {
      description:
        "Edit a routine's six agent-authorable content fields while it is unlocked. Frozen routines refuse edits. Daily cap, session, session label, enabled state, and frozen state remain panel-only.",
      inputSchema: {
        routine_id: z.number().int().positive(),
        order_text: z.string().optional(),
        verbatim_terms: z.string().optional(),
        blocked_topics: z.array(z.string()).optional(),
        required_disclosure: z.string().nullable().optional(),
        keywords: z.record(z.number()).nullable().optional(),
        score_floor: z.number().int().nullable().optional(),
      },
    },
    ({
      routine_id,
      order_text,
      verbatim_terms,
      blocked_topics,
      required_disclosure,
      keywords,
      score_floor,
    }) =>
      withDb(
        ctx,
        (db) =>
          updateRoutineContent(db, routine_id, {
            orderText: order_text,
            verbatimTerms: verbatim_terms,
            blockedTopics: blocked_topics,
            requiredDisclosure: required_disclosure,
            keywords,
            scoreFloor: score_floor,
          }),
        true,
      ),
  );

  server.registerTool(
    "sources_list",
    {
      description: "List agent-managed sources for a routine.",
      inputSchema: { routine_id: z.number().int().positive() },
    },
    ({ routine_id }) => withDb(ctx, (db) => listSources(db, routine_id)),
  );

  server.registerTool(
    "source_add",
    {
      description: "Add a source to a routine.",
      inputSchema: {
        routine_id: z.number().int().positive(),
        name: z.string().min(1),
        url: z.string().url(),
        notes: z.string().optional(),
        status: z.enum(SOURCE_STATUSES).default("candidate"),
      },
    },
    ({ routine_id, name, url, notes, status }) =>
      withDb(
        ctx,
        (db) =>
          addSource(db, { routineId: routine_id, name, url, notes, status }),
        true,
      ),
  );

  server.registerTool(
    "source_update",
    {
      description: "Update a routine source identified by its current name.",
      inputSchema: {
        routine_id: z.number().int().positive(),
        name: z.string().min(1),
        new_name: z.string().min(1).optional(),
        url: z.string().url().optional(),
        notes: z.string().optional(),
        status: z.enum(SOURCE_STATUSES).optional(),
      },
    },
    ({ routine_id, name, new_name, url, notes, status }) =>
      withDb(
        ctx,
        (db) =>
          updateSource(db, {
            routineId: routine_id,
            name,
            newName: new_name,
            url,
            notes,
            status,
          }),
        true,
      ),
  );

  server.registerTool(
    "source_remove",
    {
      description: "Remove a source from a routine.",
      inputSchema: {
        routine_id: z.number().int().positive(),
        name: z.string().min(1),
      },
    },
    ({ routine_id, name }) =>
      withDb(ctx, (db) => removeSource(db, routine_id, name), true),
  );

  server.registerTool(
    "run_start",
    {
      description: "Transition a pending run to running.",
      inputSchema: { run_id: z.number().int().positive() },
    },
    ({ run_id }) => withDb(ctx, (db) => startRun(db, run_id), true),
  );

  server.registerTool(
    "run_finish",
    {
      description:
        "Finish a run. A briefing must already exist or the run is marked failed.",
      inputSchema: {
        run_id: z.number().int().positive(),
        status: z.enum(["done", "failed"]).default("done"),
        error: z.string().optional(),
      },
    },
    ({ run_id, status, error }) =>
      withDb(ctx, (db) => finishRun(db, run_id, status, error), true),
  );

  server.registerTool(
    "items_add",
    {
      description:
        "Submit agent-fetched contacts through Mailarr intake. Routine scoring is applied only when configured.",
      inputSchema: {
        routine_id: z.number().int().positive(),
        run_id: z.number().int().positive(),
        items: z
          .array(
            z.object({
              company: z.string().min(1),
              role: z.string().min(1),
              url: z.string().url(),
              source_label: z.string().min(1),
              contact_email: z.string().optional(),
              rate_info: z.string().optional(),
              description: z.string().optional(),
              payload: z.unknown().optional(),
            }),
          )
          .min(1),
      },
    },
    ({ routine_id, run_id, items }) =>
      withDb(
        ctx,
        (db) =>
          addItems(
            db,
            routine_id,
            run_id,
            items.map((item) => ({
              company: item.company,
              role: item.role,
              url: item.url,
              sourceLabel: item.source_label,
              contactEmail: item.contact_email,
              rateInfo: item.rate_info,
              description: item.description,
              payload: item.payload,
            })),
          ),
        true,
      ),
  );

  server.registerTool(
    "items_list",
    {
      description: "Page through pipeline items for a run or routine.",
      inputSchema: {
        routine_id: z.number().int().positive().optional(),
        run_id: z.number().int().positive().optional(),
        stage: z.enum(ITEM_STAGES).optional(),
        page: z.number().int().positive().default(1),
        page_size: z.number().int().min(1).max(100).default(50),
      },
    },
    ({ routine_id, run_id, stage, page, page_size }) =>
      withDb(ctx, (db) =>
        listItems(db, {
          routineId: routine_id,
          runId: run_id,
          stage,
          page,
          pageSize: page_size,
        }),
      ),
  );

  server.registerTool(
    "item_update",
    {
      description:
        "Move an item through the pipeline and attach notes, a draft subject and body, contact email, or drop reason.",
      inputSchema: {
        item_id: z.number().int().positive(),
        stage: z.enum(ITEM_STAGES).optional(),
        fit_notes: z.string().nullable().optional(),
        draft_subject: z.string().nullable().optional(),
        draft_pitch: z.string().nullable().optional(),
        drop_reason: z.string().nullable().optional(),
        contact_email: z.string().email().nullable().optional(),
      },
    },
    ({
      item_id,
      stage,
      fit_notes,
      draft_subject,
      draft_pitch,
      drop_reason,
      contact_email,
    }) =>
      withDb(
        ctx,
        (db) =>
          updateItem(db, item_id, {
            stage,
            fitNotes: fit_notes,
            draftSubject: draft_subject,
            draftPitch: draft_pitch,
            dropReason: drop_reason,
            contactEmail: contact_email,
          }),
        true,
      ),
  );

  server.registerTool(
    "send_first_contact",
    {
      description:
        "The only mail egress. Requires a frozen routine, a qualified item, and a draft containing {{TERMS}} exactly once. Uses the stored draft subject when subject is omitted.",
      inputSchema: {
        run_id: z.number().int().positive(),
        item_id: z.number().int().positive(),
        to: z.string().email().optional(),
        subject: z.string().min(1).optional(),
        pitch: z.string().min(1),
      },
    },
    async ({ run_id, item_id, to, subject, pitch }) => {
      try {
        const current = ctx();
        const db = openMailarrDatabase(current.dataDir);
        try {
          requireFrozenRoutine(db, run_id);
          const [smtpUser, smtpPassword] = await Promise.all([
            current.secrets.get("smtp_user"),
            current.secrets.get("smtp_password"),
          ]);
          const result = await sendFirstContact({
            db,
            runId: run_id,
            itemId: item_id,
            to,
            subject,
            draft: pitch,
            smtp: {
              host: configString(current.config, "smtp_host"),
              port: configPort(current.config),
              user: smtpUser ?? "",
              password: smtpPassword ?? "",
              fromAddress: configString(current.config, "from_address"),
            },
            dryRun: dryRunEnabled(current.config),
          });

          current.broadcast({ type: "mailarr-changed" });

          return text(result);
        } finally {
          db.close();
        }
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "post_briefing",
    {
      description: "Store the run's markdown briefing.",
      inputSchema: {
        run_id: z.number().int().positive(),
        markdown: z.string().min(1),
      },
    },
    ({ run_id, markdown }) =>
      withDb(
        ctx,
        (db) => {
          saveBriefing(db, run_id, markdown);

          return { saved: true, runId: run_id };
        },
        true,
      ),
  );

  return server;
}

async function withDb<T>(
  getCtx: () => ExtensionContext,
  action: (db: ReturnType<typeof openMailarrDatabase>) => T | Promise<T>,
  broadcast = false,
) {
  try {
    const current = getCtx();
    const db = openMailarrDatabase(current.dataDir);
    try {
      const result = await action(db);

      if (broadcast) current.broadcast({ type: "mailarr-changed" });

      return text(result);
    } finally {
      db.close();
    }
  } catch (error) {
    return fail(error);
  }
}

function configString(config: Record<string, unknown>, key: string): string {
  const value = config[key];

  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function configPort(config: Record<string, unknown>): number {
  const value = Number(config.smtp_port);

  return Number.isInteger(value) ? value : 0;
}

export function dryRunEnabled(config: Record<string, unknown>): boolean {
  const value = config.dry_run;

  if (value === undefined || value === null || value === "") return true;
  if (typeof value === "boolean") return value;

  return !["false", "0", "off", "no"].includes(String(value).trim().toLowerCase());
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
