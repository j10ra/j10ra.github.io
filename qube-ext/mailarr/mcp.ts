import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ExtensionContext } from "@qube-code/extension-sdk";
import { z } from "zod";
import {
  finishRun,
  getItem,
  getRoutine,
  listItems,
  listPendingRuns,
  openMailarrDatabase,
  saveBriefing,
  startRun,
  updateItem,
} from "./lib/db.js";
import { ITEM_STAGES } from "./lib/model.js";
import { scanSources } from "./lib/scan.js";
import { sendFirstContact } from "./lib/send.js";

const text = (value: unknown) => ({
  content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
});
const fail = (error: unknown) => ({
  content: [{ type: "text" as const, text: `Error: ${message(error)}` }],
  isError: true,
});

export const MAILARR_INSTRUCTIONS = [
  "# Mailarr",
  "",
  "Mailarr owns Sebe's outreach pipeline. On a scheduler nudge, or when polling for work:",
  "",
  "1. Call routines_due.",
  "2. For each pending run, call routine_get and follow its order_text.",
  "3. Call run_start, then scan_sources.",
  "4. Page through items_list, qualify with item_update, and write one pitch per qualified lead.",
  "5. Call send_first_contact for the top qualified items until the routine cap is reached.",
  "6. Call post_briefing with counts, company names, notable drops, and source errors.",
  "7. Call run_finish.",
  "",
  "Use the commercial terms token exactly once in every draft. The send tool replaces it with",
  "settings-controlled terms, validates the pitch, enforces the daily cap and permanent company",
  "dedupe, then either records a dry run or sends through SMTP.",
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
      description: "Read a routine, including the order_text the agent must follow.",
      inputSchema: { routine_id: z.number().int().positive() },
    },
    ({ routine_id }) => withDb(ctx, (db) => getRoutine(db, routine_id)),
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
    "scan_sources",
    {
      description:
        "Fetch every configured source, score full descriptions, extract apply-context emails, " +
        "drop below-floor posts, and store discovered items. Individual source failures are recorded.",
      inputSchema: { run_id: z.number().int().positive() },
    },
    ({ run_id }) => withDb(ctx, (db) => scanSources(db, run_id), true),
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
        "Move an item through the pipeline and attach fit notes, a draft pitch, contact email, or drop reason.",
      inputSchema: {
        item_id: z.number().int().positive(),
        stage: z.enum(ITEM_STAGES).optional(),
        fit_notes: z.string().nullable().optional(),
        draft_pitch: z.string().nullable().optional(),
        drop_reason: z.string().nullable().optional(),
        contact_email: z.string().email().nullable().optional(),
      },
    },
    ({ item_id, stage, fit_notes, draft_pitch, drop_reason, contact_email }) =>
      withDb(
        ctx,
        (db) =>
          updateItem(db, item_id, {
            stage,
            fitNotes: fit_notes,
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
        "Guarded first-contact send. Requires a qualified item and a draft containing " +
        "{{COMMERCIAL_TERMS}} exactly once.",
      inputSchema: {
        run_id: z.number().int().positive(),
        item_id: z.number().int().positive(),
        to: z.string().email().optional(),
        subject: z.string().min(1),
        pitch: z.string().min(1),
      },
    },
    async ({ run_id, item_id, to, subject, pitch }) => {
      try {
        const current = ctx();
        const db = openMailarrDatabase(current.dataDir);
        try {
          const item = getItem(db, item_id);
          const [smtpUser, smtpPassword, fromAddress] = await Promise.all([
            current.secrets.get("smtp_user"),
            current.secrets.get("smtp_password"),
            current.secrets.get("from_address"),
          ]);
          const result = await sendFirstContact({
            db,
            runId: run_id,
            itemId: item_id,
            to: to ?? item.contactEmail ?? "",
            subject,
            draft: pitch,
            commercial: {
              hourlyFloor: configString(current.config, "hourly_floor"),
              targetRate: configString(current.config, "target_rate"),
              premiumBand: configString(current.config, "premium_band"),
              weeklyHours: configString(current.config, "weekly_hours"),
            },
            smtp: {
              user: smtpUser ?? "",
              password: smtpPassword ?? "",
              fromAddress: fromAddress ?? "",
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

function dryRunEnabled(config: Record<string, unknown>): boolean {
  const value = config.dry_run;

  if (value === undefined || value === null || value === "") return true;
  if (typeof value === "boolean") return value;

  return !["false", "0", "off", "no"].includes(String(value).trim().toLowerCase());
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
