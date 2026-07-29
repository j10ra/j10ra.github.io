import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  Item,
  ItemOrigin,
  ItemStage,
  NormalizedPosting,
  Routine,
  Run,
  RunStatus,
} from "./model.js";

const JOB_SCOUT_ORDER = [
  "Scan every configured source.",
  "Qualify against the full description for senior React, TypeScript, or full-stack work.",
  "Prefer AI, agent, and MCP work.",
  "Compose one Sebe-persona pitch per qualified lead.",
  "Send the top qualified leads until the daily cap is reached.",
  "Post a briefing with found, qualified, and sent counts, company names, notable drops, and errors.",
].join(" ");

const nowIso = () => new Date().toISOString();

export function normalizeCompany(company: string): string {
  return company
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

export function openMailarrDatabase(dataDir: string): DatabaseSync {
  mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(join(dataDir, "mailarr.db"));

  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db);

  return db;
}

export function migrate(db: DatabaseSync): void {
  const versionRow = db.prepare("PRAGMA user_version").get() as { user_version: number };
  const version = Number(versionRow.user_version);

  db.exec(`
    CREATE TABLE IF NOT EXISTS routines (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      cron TEXT NOT NULL,
      order_text TEXT NOT NULL,
      daily_cap INTEGER NOT NULL CHECK (daily_cap > 0),
      sources TEXT,
      enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      routine_id INTEGER NOT NULL REFERENCES routines(id) ON DELETE CASCADE,
      started_at TEXT,
      finished_at TEXT,
      created_at TEXT NOT NULL,
      scheduled_for TEXT,
      status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'done', 'failed')),
      error_text TEXT,
      found_count INTEGER NOT NULL DEFAULT 0,
      qualified_count INTEGER NOT NULL DEFAULT 0,
      sent_count INTEGER NOT NULL DEFAULT 0,
      UNIQUE (routine_id, scheduled_for)
    );

    CREATE TABLE IF NOT EXISTS items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      routine_id INTEGER NOT NULL REFERENCES routines(id) ON DELETE CASCADE,
      run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      stage TEXT NOT NULL CHECK (stage IN ('discovered', 'qualified', 'contacted', 'replied', 'dropped')),
      company TEXT NOT NULL,
      normalized_company TEXT NOT NULL,
      role TEXT NOT NULL,
      rate_info TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL,
      origin TEXT NOT NULL DEFAULT 'scan' CHECK (origin IN ('scan', 'intake')),
      url TEXT NOT NULL,
      contact_email TEXT,
      score INTEGER NOT NULL DEFAULT 0,
      fit_notes TEXT,
      draft_pitch TEXT,
      sent_pitch TEXT,
      drop_reason TEXT,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (normalized_company, url)
    );

    CREATE TABLE IF NOT EXISTS sent_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company TEXT NOT NULL,
      normalized_company TEXT NOT NULL,
      email TEXT NOT NULL,
      subject TEXT NOT NULL,
      body TEXT NOT NULL,
      sent_at TEXT NOT NULL,
      run_id INTEGER REFERENCES runs(id) ON DELETE SET NULL,
      dry_run INTEGER NOT NULL DEFAULT 0 CHECK (dry_run IN (0, 1))
    );

    CREATE TABLE IF NOT EXISTS briefings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id INTEGER NOT NULL UNIQUE REFERENCES runs(id) ON DELETE CASCADE,
      markdown_body TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

  `);
  if (version < 1) seedInitialData(db);
  if (version < 2) migrateLegacySentLog(db);
  if (version < 3) migrateRoutineSources(db);
  if (version < 4) migrateItemOrigins(db);

  db.exec(`
    CREATE INDEX IF NOT EXISTS runs_status_idx ON runs(status);
    CREATE INDEX IF NOT EXISTS items_run_stage_idx ON items(run_id, stage);
    CREATE INDEX IF NOT EXISTS sent_log_sent_at_idx ON sent_log(sent_at);
    CREATE UNIQUE INDEX IF NOT EXISTS sent_log_real_company_idx
      ON sent_log(normalized_company)
      WHERE dry_run = 0;
  `);

  db.exec("PRAGMA user_version = 4");
}

function migrateRoutineSources(db: DatabaseSync): void {
  const columns = db.prepare("PRAGMA table_info(routines)").all() as Array<{ name: string }>;

  if (!columns.some((column) => column.name === "sources")) {
    db.exec("ALTER TABLE routines ADD COLUMN sources TEXT");
  }
}

function migrateItemOrigins(db: DatabaseSync): void {
  const columns = db.prepare("PRAGMA table_info(items)").all() as Array<{ name: string }>;

  if (!columns.some((column) => column.name === "origin")) {
    db.exec(`
      ALTER TABLE items
      ADD COLUMN origin TEXT NOT NULL DEFAULT 'scan'
        CHECK (origin IN ('scan', 'intake'))
    `);
  }
}

function migrateLegacySentLog(db: DatabaseSync): void {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'sent_log'")
    .get() as { sql?: string } | undefined;

  if (!row?.sql || !/normalized_company\s+TEXT\s+NOT NULL\s+UNIQUE/iu.test(row.sql)) return;

  db.exec("PRAGMA foreign_keys = OFF");
  try {
    db.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE sent_log_next (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        company TEXT NOT NULL,
        normalized_company TEXT NOT NULL,
        email TEXT NOT NULL,
        subject TEXT NOT NULL,
        body TEXT NOT NULL,
        sent_at TEXT NOT NULL,
        run_id INTEGER REFERENCES runs(id) ON DELETE SET NULL,
        dry_run INTEGER NOT NULL DEFAULT 0 CHECK (dry_run IN (0, 1))
      );
      INSERT INTO sent_log_next
        (id, company, normalized_company, email, subject, body, sent_at, run_id, dry_run)
      SELECT id, company, normalized_company, email, subject, body, sent_at, run_id, dry_run
      FROM sent_log;
      DROP TABLE sent_log;
      ALTER TABLE sent_log_next RENAME TO sent_log;
      COMMIT;
    `);
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {}
    throw error;
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
}

function seedInitialData(db: DatabaseSync): void {
  const seededAt = "2026-07-28T00:00:00.000Z";

  db.prepare(`
    INSERT OR IGNORE INTO routines
      (name, cron, order_text, daily_cap, enabled, created_at, updated_at)
    VALUES (?, ?, ?, ?, 0, ?, ?)
  `).run("Job Scout", "0 9 * * *", JOB_SCOUT_ORDER, 5, seededAt, seededAt);
  const seedSent = db.prepare(`
    INSERT OR IGNORE INTO sent_log
      (company, normalized_company, email, subject, body, sent_at, run_id, dry_run)
    VALUES (?, ?, '', 'Imported contact record', '', ?, NULL, 0)
  `);

  for (const company of ["Faithlife", "Very Real Help"]) {
    seedSent.run(company, normalizeCompany(company), seededAt);
  }
}

export function createRoutine(
  db: DatabaseSync,
  input: {
    name: string;
    cron: string;
    orderText: string;
    dailyCap: number;
    sources?: string[] | null;
  },
): Routine {
  const at = nowIso();
  const result = db
    .prepare(`
      INSERT INTO routines
        (name, cron, order_text, daily_cap, sources, enabled, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 0, ?, ?)
    `)
    .run(
      input.name.trim(),
      input.cron.trim(),
      input.orderText.trim(),
      input.dailyCap,
      serializeSources(input.sources),
      at,
      at,
    );

  return getRoutine(db, Number(result.lastInsertRowid));
}

export function updateRoutine(
  db: DatabaseSync,
  id: number,
  input: {
    name: string;
    cron: string;
    orderText: string;
    dailyCap: number;
    sources?: string[] | null;
  },
): Routine {
  const result = db
    .prepare(`
      UPDATE routines
      SET name = ?, cron = ?, order_text = ?, daily_cap = ?, sources = ?, updated_at = ?
      WHERE id = ?
    `)
    .run(
      input.name.trim(),
      input.cron.trim(),
      input.orderText.trim(),
      input.dailyCap,
      serializeSources(input.sources),
      nowIso(),
      id,
    );

  if (result.changes === 0) throw new Error(`routine ${id} not found`);

  return getRoutine(db, id);
}

export function setRoutineEnabled(db: DatabaseSync, id: number, enabled: boolean): Routine {
  const result = db
    .prepare("UPDATE routines SET enabled = ?, updated_at = ? WHERE id = ?")
    .run(enabled ? 1 : 0, nowIso(), id);

  if (result.changes === 0) throw new Error(`routine ${id} not found`);

  return getRoutine(db, id);
}

export function getRoutine(db: DatabaseSync, id: number): Routine {
  const row = db.prepare("SELECT * FROM routines WHERE id = ?").get(id) as DbRow | undefined;

  if (!row) throw new Error(`routine ${id} not found`);

  return routineFromRow(row);
}

export function listRoutines(db: DatabaseSync): Routine[] {
  return (db.prepare("SELECT * FROM routines ORDER BY name").all() as DbRow[]).map(routineFromRow);
}

export function listEnabledRoutines(db: DatabaseSync): Routine[] {
  return (
    db.prepare("SELECT * FROM routines WHERE enabled = 1 ORDER BY id").all() as DbRow[]
  ).map(routineFromRow);
}

export function createRun(
  db: DatabaseSync,
  routineId: number,
  scheduledFor: string | null = null,
): Run {
  getRoutine(db, routineId);
  const result = db
    .prepare(`
      INSERT OR IGNORE INTO runs
        (routine_id, created_at, scheduled_for, status)
      VALUES (?, ?, ?, 'pending')
    `)
    .run(routineId, nowIso(), scheduledFor);

  if (result.changes === 0 && scheduledFor) {
    const existing = db
      .prepare("SELECT * FROM runs WHERE routine_id = ? AND scheduled_for = ?")
      .get(routineId, scheduledFor) as DbRow;

    return runFromRow(existing);
  }

  return getRun(db, Number(result.lastInsertRowid));
}

export function getRun(db: DatabaseSync, id: number): Run {
  const row = db.prepare("SELECT * FROM runs WHERE id = ?").get(id) as DbRow | undefined;

  if (!row) throw new Error(`run ${id} not found`);

  return runFromRow(row);
}

export function listPendingRuns(db: DatabaseSync): Array<Run & { routineName: string }> {
  return (
    db
      .prepare(`
        SELECT runs.*, routines.name AS routine_name
        FROM runs
        JOIN routines ON routines.id = runs.routine_id
        WHERE runs.status = 'pending'
        ORDER BY runs.created_at
      `)
      .all() as DbRow[]
  ).map((row) => ({ ...runFromRow(row), routineName: String(row.routine_name) }));
}

export function startRun(db: DatabaseSync, id: number): Run {
  const result = db
    .prepare(`
      UPDATE runs
      SET status = 'running', started_at = COALESCE(started_at, ?), finished_at = NULL
      WHERE id = ? AND status = 'pending'
    `)
    .run(nowIso(), id);

  if (result.changes === 0) {
    const run = getRun(db, id);

    if (run.status !== "running") throw new Error(`run ${id} cannot start from ${run.status}`);
  }

  return getRun(db, id);
}

export function finishRun(
  db: DatabaseSync,
  id: number,
  status: Extract<RunStatus, "done" | "failed">,
  errorText?: string,
): Run {
  const current = getRun(db, id);
  const briefing = db.prepare("SELECT 1 FROM briefings WHERE run_id = ?").get(id);

  if (!briefing) {
    db.prepare(`
      UPDATE runs
      SET status = 'failed', finished_at = ?, error_text = ?
      WHERE id = ?
    `).run(nowIso(), "Run finished without a briefing", id);
    throw new Error("run_finish requires a briefing from post_briefing");
  }

  const finalStatus = current.status === "failed" ? "failed" : status;
  const result = db
    .prepare(`
      UPDATE runs
      SET status = ?, finished_at = ?, error_text = COALESCE(?, error_text)
      WHERE id = ? AND status IN ('running', 'failed')
    `)
    .run(finalStatus, nowIso(), errorText ?? null, id);

  if (result.changes === 0) throw new Error(`run ${id} is not active`);

  return getRun(db, id);
}

export function recordScanResult(
  db: DatabaseSync,
  id: number,
  foundCount: number,
  errors: string[],
  fullyFailed: boolean,
): Run {
  const errorText = errors.length ? errors.join("\n") : null;
  const result = db
    .prepare(`
      UPDATE runs
      SET found_count = found_count + ?,
          error_text = ?,
          status = CASE WHEN ? = 1 THEN 'failed' ELSE status END,
          finished_at = CASE WHEN ? = 1 THEN ? ELSE finished_at END
      WHERE id = ?
    `)
    .run(foundCount, errorText, fullyFailed ? 1 : 0, fullyFailed ? 1 : 0, nowIso(), id);

  if (result.changes === 0) throw new Error(`run ${id} not found`);

  return getRun(db, id);
}

export function incrementRunFoundCount(
  db: DatabaseSync,
  id: number,
  foundCount: number,
): Run {
  const result = db
    .prepare("UPDATE runs SET found_count = found_count + ? WHERE id = ?")
    .run(foundCount, id);

  if (result.changes === 0) throw new Error(`run ${id} not found`);

  return getRun(db, id);
}

export function insertPosting(
  db: DatabaseSync,
  routineId: number,
  runId: number,
  posting: NormalizedPosting,
  score: number,
  contactEmail: string | null,
  origin: ItemOrigin = "scan",
): "inserted" | "refreshed" | "ignored" {
  const at = nowIso();
  const normalizedCompany = normalizeCompany(posting.company);
  const payload = {
    raw: posting.payload,
    description: posting.description,
    publishedAt: posting.publishedAt,
  };
  const result = db
    .prepare(`
      INSERT OR IGNORE INTO items (
        routine_id, run_id, stage, company, normalized_company, role, rate_info, source, origin,
        url, contact_email, score, payload_json, created_at, updated_at
      ) VALUES (?, ?, 'discovered', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      routineId,
      runId,
      posting.company,
      normalizedCompany,
      posting.role,
      posting.rateInfo,
      posting.source,
      origin,
      posting.url,
      contactEmail,
      score,
      JSON.stringify(payload),
      at,
      at,
    );

  if (result.changes > 0) return "inserted";

  const existing = db
    .prepare(`
      SELECT origin, payload_json
      FROM items
      WHERE normalized_company = ? AND url = ?
    `)
    .get(normalizedCompany, posting.url) as
    | { origin: ItemOrigin; payload_json: string }
    | undefined;

  if (!existing) throw new Error("posting conflict could not be resolved");

  const preserveScannedDescription = origin === "intake" && existing.origin === "scan";
  const existingPayload = JSON.parse(existing.payload_json) as Record<string, unknown>;
  const nextPayload = preserveScannedDescription
    ? {
        ...payload,
        description:
          typeof existingPayload.description === "string"
            ? existingPayload.description
            : "",
      }
    : payload;
  const nextOrigin: ItemOrigin =
    origin === "scan" || existing.origin === "scan" ? "scan" : "intake";
  const refreshed = db
    .prepare(`
      UPDATE items
      SET run_id = CASE WHEN routine_id = ? THEN ? ELSE run_id END,
          company = ?,
          role = ?,
          rate_info = ?,
          source = ?,
          contact_email = COALESCE(?, contact_email),
          score = ?,
          origin = ?,
          payload_json = ?,
          updated_at = ?
      WHERE normalized_company = ?
        AND url = ?
        AND stage IN ('discovered', 'qualified')
    `)
    .run(
      routineId,
      runId,
      posting.company,
      posting.role,
      posting.rateInfo,
      posting.source,
      contactEmail,
      score,
      nextOrigin,
      JSON.stringify(nextPayload),
      at,
      normalizedCompany,
      posting.url,
    );

  return refreshed.changes > 0 ? "refreshed" : "ignored";
}

export function getItem(db: DatabaseSync, id: number): Item {
  const row = db
    .prepare(`
      SELECT items.*,
        EXISTS (
          SELECT 1
          FROM sent_log
          WHERE sent_log.run_id = items.run_id
            AND sent_log.normalized_company = items.normalized_company
            AND sent_log.dry_run = 1
        ) AS contacted_dry_run
      FROM items
      WHERE items.id = ?
    `)
    .get(id) as DbRow | undefined;

  if (!row) throw new Error(`item ${id} not found`);

  return itemFromRow(row);
}

export function listItems(
  db: DatabaseSync,
  input: { routineId?: number; runId?: number; stage?: ItemStage; page: number; pageSize: number },
): { items: Item[]; total: number } {
  const filters: string[] = [];
  const params: Array<string | number> = [];

  if (input.routineId !== undefined) {
    filters.push("routine_id = ?");
    params.push(input.routineId);
  }
  if (input.runId !== undefined) {
    filters.push("run_id = ?");
    params.push(input.runId);
  }
  if (input.stage) {
    filters.push("stage = ?");
    params.push(input.stage);
  }

  const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
  const total = Number(
    (db.prepare(`SELECT COUNT(*) AS count FROM items ${where}`).get(...params) as DbRow).count,
  );
  const rows = db
    .prepare(`
      SELECT items.*,
        EXISTS (
          SELECT 1
          FROM sent_log
          WHERE sent_log.run_id = items.run_id
            AND sent_log.normalized_company = items.normalized_company
            AND sent_log.dry_run = 1
        ) AS contacted_dry_run
      FROM items
      ${where}
      ORDER BY created_at DESC, id DESC
      LIMIT ? OFFSET ?
    `)
    .all(...params, input.pageSize, (input.page - 1) * input.pageSize) as DbRow[];

  return { items: rows.map(itemFromRow), total };
}

export function updateItem(
  db: DatabaseSync,
  id: number,
  input: {
    stage?: ItemStage;
    fitNotes?: string | null;
    draftPitch?: string | null;
    dropReason?: string | null;
    contactEmail?: string | null;
  },
): Item {
  const before = getItem(db, id);
  const nextStage = input.stage ?? before.stage;
  const result = db
    .prepare(`
      UPDATE items
      SET stage = ?,
          fit_notes = ?,
          draft_pitch = ?,
          drop_reason = ?,
          contact_email = ?,
          updated_at = ?
      WHERE id = ?
    `)
    .run(
      nextStage,
      input.fitNotes === undefined ? before.fitNotes : input.fitNotes,
      input.draftPitch === undefined ? before.draftPitch : input.draftPitch,
      input.dropReason === undefined ? before.dropReason : input.dropReason,
      input.contactEmail === undefined ? before.contactEmail : input.contactEmail,
      nowIso(),
      id,
    );

  if (result.changes === 0) throw new Error(`item ${id} not found`);
  if (before.stage !== "qualified" && nextStage === "qualified") {
    db.prepare("UPDATE runs SET qualified_count = qualified_count + 1 WHERE id = ?").run(
      before.runId,
    );
  }

  return getItem(db, id);
}

export function saveBriefing(db: DatabaseSync, runId: number, markdown: string): void {
  const run = getRun(db, runId);
  const sourceErrors =
    run.errorText && !markdown.includes(run.errorText)
      ? `\n\n## Source errors\n\n${run.errorText}`
      : "";

  db.prepare(`
    INSERT INTO briefings (run_id, markdown_body, created_at)
    VALUES (?, ?, ?)
    ON CONFLICT(run_id) DO UPDATE SET markdown_body = excluded.markdown_body
  `).run(runId, `${markdown.trim()}${sourceErrors}`, nowIso());
}

export function latestBriefing(
  db: DatabaseSync,
  routineId: number,
): { runId: number; markdown: string; createdAt: string } | null {
  const row = db
    .prepare(`
      SELECT briefings.run_id, briefings.markdown_body, briefings.created_at
      FROM briefings
      JOIN runs ON runs.id = briefings.run_id
      WHERE runs.routine_id = ?
      ORDER BY briefings.created_at DESC
      LIMIT 1
    `)
    .get(routineId) as DbRow | undefined;

  return row
    ? {
        runId: Number(row.run_id),
        markdown: String(row.markdown_body),
        createdAt: String(row.created_at),
      }
    : null;
}

export function sentTodayCount(db: DatabaseSync, routineId: number, now = new Date()): number {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  const row = db
    .prepare(`
      SELECT COUNT(*) AS count
      FROM sent_log
      JOIN runs ON runs.id = sent_log.run_id
      WHERE runs.routine_id = ? AND sent_at >= ? AND sent_at < ?
    `)
    .get(routineId, start.toISOString(), end.toISOString()) as DbRow;

  return Number(row.count);
}

export function hasSentCompany(db: DatabaseSync, company: string): boolean {
  return Boolean(
    db
      .prepare("SELECT 1 FROM sent_log WHERE normalized_company = ? AND dry_run = 0")
      .get(normalizeCompany(company)),
  );
}

export function recordSent(
  db: DatabaseSync,
  input: {
    company: string;
    email: string;
    subject: string;
    body: string;
    sentAt: string;
    runId: number;
    dryRun: boolean;
    itemId: number;
  },
): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(`
      INSERT INTO sent_log
        (company, normalized_company, email, subject, body, sent_at, run_id, dry_run)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.company,
      normalizeCompany(input.company),
      input.email,
      input.subject,
      input.body,
      input.sentAt,
      input.runId,
      input.dryRun ? 1 : 0,
    );
    db.prepare(`
      UPDATE items
      SET stage = 'contacted',
          sent_pitch = ?,
          contact_email = ?,
          updated_at = ?
      WHERE id = ?
    `).run(
      input.body,
      input.email,
      input.sentAt,
      input.itemId,
    );
    db.prepare("UPDATE runs SET sent_count = sent_count + 1 WHERE id = ?").run(input.runId);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function routineDashboard(db: DatabaseSync): Array<
  Routine & {
    lastRun: Run | null;
    newLeads: number;
    sentToday: number;
  }
> {
  return listRoutines(db).map((routine) => {
    const lastRow = db
      .prepare("SELECT * FROM runs WHERE routine_id = ? ORDER BY created_at DESC LIMIT 1")
      .get(routine.id) as DbRow | undefined;
    const leadRow = db
      .prepare(`
        SELECT COUNT(*) AS count FROM items
        WHERE routine_id = ? AND stage IN ('discovered', 'qualified')
      `)
      .get(routine.id) as DbRow;

    return {
      ...routine,
      lastRun: lastRow ? runFromRow(lastRow) : null,
      newLeads: Number(leadRow.count),
      sentToday: sentTodayCount(db, routine.id),
    };
  });
}

export function pipelineCounts(db: DatabaseSync, routineId: number): Record<string, number> {
  const counts: Record<string, number> = {
    all: 0,
    discovered: 0,
    qualified: 0,
    contacted: 0,
    replied: 0,
    dropped: 0,
  };
  const rows = db
    .prepare("SELECT stage, COUNT(*) AS count FROM items WHERE routine_id = ? GROUP BY stage")
    .all(routineId) as DbRow[];

  for (const row of rows) {
    counts[String(row.stage)] = Number(row.count);
    counts.all += Number(row.count);
  }

  return counts;
}

type DbRow = Record<string, string | number | bigint | null>;

function routineFromRow(row: DbRow): Routine {
  return {
    id: Number(row.id),
    name: String(row.name),
    cron: String(row.cron),
    orderText: String(row.order_text),
    dailyCap: Number(row.daily_cap),
    sources: parseSources(row.sources),
    enabled: Boolean(row.enabled),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function serializeSources(sources: string[] | null | undefined): string | null {
  return sources == null ? null : JSON.stringify([...new Set(sources)]);
}

function parseSources(value: DbRow[string]): string[] | null {
  if (value == null) return null;

  const parsed = JSON.parse(String(value)) as unknown;

  if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== "string")) {
    throw new Error("routine sources must be a JSON string array");
  }

  return parsed;
}

function runFromRow(row: DbRow): Run {
  return {
    id: Number(row.id),
    routineId: Number(row.routine_id),
    startedAt: row.started_at ? String(row.started_at) : null,
    finishedAt: row.finished_at ? String(row.finished_at) : null,
    createdAt: String(row.created_at),
    scheduledFor: row.scheduled_for ? String(row.scheduled_for) : null,
    status: String(row.status) as RunStatus,
    errorText: row.error_text ? String(row.error_text) : null,
    foundCount: Number(row.found_count),
    qualifiedCount: Number(row.qualified_count),
    sentCount: Number(row.sent_count),
  };
}

function itemFromRow(row: DbRow): Item {
  return {
    id: Number(row.id),
    routineId: Number(row.routine_id),
    runId: Number(row.run_id),
    stage: String(row.stage) as ItemStage,
    company: String(row.company),
    normalizedCompany: String(row.normalized_company),
    role: String(row.role),
    rateInfo: String(row.rate_info),
    source: String(row.source),
    origin: String(row.origin) as ItemOrigin,
    url: String(row.url),
    contactEmail: row.contact_email ? String(row.contact_email) : null,
    score: Number(row.score),
    fitNotes: row.fit_notes ? String(row.fit_notes) : null,
    draftPitch: row.draft_pitch ? String(row.draft_pitch) : null,
    sentPitch: row.sent_pitch ? String(row.sent_pitch) : null,
    contactedDryRun: Boolean(row.contacted_dry_run),
    dropReason: row.drop_reason ? String(row.drop_reason) : null,
    payload: JSON.parse(String(row.payload_json)),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}
