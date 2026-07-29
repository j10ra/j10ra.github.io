import { useEffect, useState } from "react";
import {
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  Mail,
  Play,
  Plus,
  RefreshCw,
  Save,
  Settings2,
  Trash2,
  XCircle,
} from "lucide-react";
import { request, type WebExtension } from "@qube-code/extension-sdk/web";

type Stage = "discovered" | "qualified" | "contacted" | "replied" | "dropped";
type SourceStatus = "candidate" | "verified" | "dead";

interface Run {
  id: number;
  status: "pending" | "running" | "done" | "failed";
  createdAt: string;
  foundCount: number;
  qualifiedCount: number;
  sentCount: number;
}

interface Routine {
  id: number;
  name: string;
  cron: string;
  orderText: string;
  session: string | null;
  sessionLabel: string | null;
  dailyCap: number;
  verbatimTerms: string;
  blockedTopics: string[];
  requiredDisclosure: string | null;
  keywords: Record<string, number> | null;
  scoreFloor: number | null;
  enabled: boolean;
  frozen: boolean;
  frozenAt: string | null;
  editedSinceFreeze: boolean;
  updatedAt: string;
  lastRun: Run | null;
  hasPendingRun: boolean;
  pendingRun: Run | null;
  pendingRunCount: number;
  newLeads: number;
  sentToday: number;
}

interface RoutineSource {
  routineId: number;
  name: string;
  url: string;
  notes: string;
  status: SourceStatus;
}

interface Item {
  id: number;
  company: string;
  role: string;
  rateInfo: string;
  source: string;
  url: string;
  stage: Stage;
  score: number;
  contactEmail: string | null;
  fitNotes: string | null;
  draftSubject: string | null;
  draftPitch: string | null;
  sentSubject: string | null;
  sentPitch: string | null;
  dropReason: string | null;
  createdAt: string;
}

interface Pipeline {
  routine: Routine;
  sources: RoutineSource[];
  counts: Record<"all" | Stage, number>;
  briefing: { markdown: string; createdAt: string } | null;
  items: Item[];
}

interface RoutineForm {
  name: string;
  cron: string;
  orderText: string;
  session: string;
  sessionLabel: string;
  dailyCap: number;
  verbatimTerms: string;
  blockedTopics: string;
  requiredDisclosure: string;
  keywords: KeywordWeight[];
  scoreFloor: string;
}

type WorkbenchTarget = number | "new";

interface StoredFormDraft {
  value: RoutineForm;
  reviewedUpdatedAt: string | null;
}

interface WorkbenchViewState {
  stage: "all" | Stage;
  expandedItemId: number | null;
  briefingExpanded: boolean;
  reviewingFreeze: boolean;
  view: "pipeline" | "edit";
}

interface PanelViewState {
  fallbackTarget: WorkbenchTarget | null;
  lastOpenedRoutineId: number | null;
  workbenches: Record<string, WorkbenchViewState>;
  forms: Record<string, StoredFormDraft>;
}

interface KeywordWeight {
  id: number;
  term: string;
  weight: string;
}

const EMPTY_FORM: RoutineForm = {
  name: "",
  cron: "0 9 * * *",
  orderText: "",
  session: "",
  sessionLabel: "",
  dailyCap: 5,
  verbatimTerms: "",
  blockedTopics: "",
  requiredDisclosure: "",
  keywords: [],
  scoreFloor: "",
};
const INPUT_CLASS =
  "w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:bg-input/50 disabled:opacity-50";
const ITEM_GRID: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "28px 1.1fr 1.4fr 0.8fr 0.7fr 70px 120px",
  minWidth: 820,
};
const STAGES: Array<"all" | Stage> = [
  "all",
  "discovered",
  "qualified",
  "contacted",
  "replied",
  "dropped",
];
const SOURCE_STATUS_ORDER: Record<SourceStatus, number> = {
  verified: 0,
  candidate: 1,
  dead: 2,
};
const SOURCE_STATUS_CLASS: Record<SourceStatus, string> = {
  candidate: "border-border bg-muted text-muted-foreground",
  verified: "border-emerald-500 bg-background text-emerald-500",
  dead: "border-destructive/40 bg-destructive/10 text-destructive",
};

export function createMemoryStore<T>() {
  const values = new Map<string, T>();

  return {
    read: (key: string): T | undefined => values.get(key),
    write: (key: string, value: T): void => {
      values.set(key, value);
    },
    remove: (key: string): void => {
      values.delete(key);
    },
  };
}

const mailarrUiState = createMemoryStore<PanelViewState>();

function panelViewState(worktreeId: number): PanelViewState {
  const key = String(worktreeId);
  const current = mailarrUiState.read(key);

  if (current) return current;

  const created: PanelViewState = {
    fallbackTarget: null,
    lastOpenedRoutineId: null,
    workbenches: {},
    forms: {},
  };

  mailarrUiState.write(key, created);

  return created;
}

function updatePanelViewState(
  worktreeId: number,
  update: (current: PanelViewState) => PanelViewState,
): void {
  mailarrUiState.write(String(worktreeId), update(panelViewState(worktreeId)));
}

function workbenchStateKey(target: WorkbenchTarget): string {
  return target === "new" ? "new" : `routine:${target}`;
}

function defaultWorkbenchState(target: WorkbenchTarget): WorkbenchViewState {
  return {
    stage: "all",
    expandedItemId: null,
    briefingExpanded: false,
    reviewingFreeze: false,
    view: target === "new" ? "edit" : "pipeline",
  };
}

export function serializeKeywordWeights(
  rows: Array<{ term: string; weight: string }>,
): Record<string, number> | null {
  const keywords = new Map<string, number>();

  for (const row of rows) {
    const term = row.term.trim();

    if (!term) continue;
    if (!row.weight.trim()) {
      throw new Error(`Weight for "${term}" is required`);
    }

    const weight = Number(row.weight);

    if (!Number.isFinite(weight)) {
      throw new Error(`Weight for "${term}" must be finite`);
    }

    keywords.set(term, weight);
  }

  return keywords.size ? Object.fromEntries(keywords) : null;
}

export function pendingAge(createdAt: string, now = new Date()): string {
  const elapsedSeconds = Math.max(
    0,
    Math.floor((now.getTime() - new Date(createdAt).getTime()) / 1_000),
  );

  if (elapsedSeconds < 60) return "<1m";
  if (elapsedSeconds < 3_600) return `${Math.floor(elapsedSeconds / 60)}m`;
  if (elapsedSeconds < 86_400) return `${Math.floor(elapsedSeconds / 3_600)}h`;

  return `${Math.floor(elapsedSeconds / 86_400)}d`;
}

export function briefingSummary(markdown: string, limit = 120): string {
  const summary = markdown
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find(Boolean)
    ?.replace(/^#{1,6}\s+/u, "")
    .replace(/^[-*+]\s+/u, "")
    .replace(/^\d+\.\s+/u, "")
    .replace(/(\*\*|__|\*|_|`)/gu, "")
    .replace(/\s+/gu, " ")
    .trim();

  if (!summary) return "No briefing content.";
  if (summary.length <= limit) return summary;

  return `${summary.slice(0, Math.max(1, limit - 1)).trimEnd()}…`;
}

const mailarr: WebExtension = {
  id: "mailarr",
  panels: [
    {
      id: "mailarr",
      icon: Mail,
      title: "Mailarr",
      scope: "session",
      render: (worktreeId) => <MailarrPanel worktreeId={worktreeId} />,
    },
  ],
  editors: [
    {
      id: "workbench",
      icon: Mail,
      render: (worktreeId, payload) => {
        const target = workbenchTarget(payload);

        return target ? (
          <RoutineWorkbench initialTarget={target} worktreeId={worktreeId} />
        ) : (
          <Notice tone="error">Invalid Mailarr workbench payload.</Notice>
        );
      },
    },
  ],
};

function MailarrPanel({ worktreeId }: { worktreeId: number }) {
  const restored = panelViewState(worktreeId);
  const [routines, setRoutines] = useState<Routine[]>([]);
  const [fallbackTarget, setFallbackTarget] = useState<WorkbenchTarget | null>(
    restored.fallbackTarget,
  );
  const [lastOpenedRoutineId, setLastOpenedRoutineId] = useState<number | null>(
    restored.lastOpenedRoutineId,
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const rememberFallbackTarget = (target: WorkbenchTarget | null) => {
    setFallbackTarget(target);
    updatePanelViewState(worktreeId, (current) => ({
      ...current,
      fallbackTarget: target,
    }));
  };
  const rememberLastOpened = (routineId: number | null) => {
    setLastOpenedRoutineId(routineId);
    updatePanelViewState(worktreeId, (current) => ({
      ...current,
      lastOpenedRoutineId: routineId,
    }));
  };

  const load = async () => {
    setLoading(true);
    try {
      const result = await request<{ routines: Routine[] }>("/api/mailarr/routines");
      setRoutines(result.routines);
      setError(null);
    } catch (nextError) {
      setError(message(nextError));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  if (fallbackTarget) {
    return (
      <RoutineWorkbench
        initialTarget={fallbackTarget}
        worktreeId={worktreeId}
        onTargetChanged={rememberFallbackTarget}
        onBack={async () => {
          rememberFallbackTarget(null);
          await load();
        }}
      />
    );
  }

  return (
    <div className="flex h-full flex-col gap-3 p-3 text-foreground">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold">Mailarr</h2>
          <p className="text-xs text-muted-foreground">Guarded first-contact routines</p>
        </div>
        <button
          className="rounded-md border border-border p-1.5 hover:bg-muted"
          onClick={() => {
            if (!openRoutineWorkbench(worktreeId, null)) {
              rememberFallbackTarget("new");
            }
          }}
          title="New routine"
        >
          <Plus size={16} />
        </button>
      </div>

      {error && <Notice tone="error">{error}</Notice>}
      {loading && <p className="text-xs text-muted-foreground">Loading...</p>}
      {!loading && routines.length === 0 && (
        <p className="rounded-md border border-dashed border-border p-3 text-xs text-muted-foreground">
          No routines yet.
        </p>
      )}

      <RoutineList
        routines={routines}
        worktreeId={worktreeId}
        lastOpenedRoutineId={lastOpenedRoutineId}
        onOpen={(routine) => {
          rememberLastOpened(routine.id);
          if (!openRoutineWorkbench(worktreeId, routine)) {
            rememberFallbackTarget(routine.id);
          }
        }}
      />
    </div>
  );
}

function RoutineList({
  routines,
  worktreeId,
  lastOpenedRoutineId,
  onOpen,
}: {
  routines: Routine[];
  worktreeId: number;
  lastOpenedRoutineId: number | null;
  onOpen: (routine: Routine) => void;
}) {
  const useActiveKey = getEditorTabs()?.useActiveKey;

  return typeof useActiveKey === "function" ? (
    <FocusedRoutineList
      routines={routines}
      worktreeId={worktreeId}
      useActiveKey={useActiveKey}
      onOpen={onOpen}
    />
  ) : (
    <RoutineRows
      routines={routines}
      activeRoutineId={lastOpenedRoutineId}
      onOpen={onOpen}
    />
  );
}

function FocusedRoutineList({
  routines,
  worktreeId,
  useActiveKey,
  onOpen,
}: {
  routines: Routine[];
  worktreeId: number;
  useActiveKey: (
    worktreeId: number,
    ext: string,
    editor: string,
  ) => string | null;
  onOpen: (routine: Routine) => void;
}) {
  const activeKey = useActiveKey(worktreeId, "mailarr", "workbench");

  return (
    <RoutineRows
      routines={routines}
      activeRoutineId={routineIdFromWorkbenchKey(activeKey)}
      onOpen={onOpen}
    />
  );
}

function RoutineRows({
  routines,
  activeRoutineId,
  onOpen,
}: {
  routines: Routine[];
  activeRoutineId: number | null;
  onOpen: (routine: Routine) => void;
}) {
  return (
    <div className="space-y-1.5 overflow-auto">
      {routines.map((routine) => {
        const active = routine.id === activeRoutineId;
        const failed = routine.lastRun?.status === "failed";

        return (
          <button
            key={routine.id}
            className={`w-full rounded-md border p-2.5 text-left outline-none transition-colors focus-visible:ring-3 focus-visible:ring-ring/50 ${
              active && failed
                ? "border-destructive bg-primary/10 ring-1 ring-primary/50"
                : active
                ? "border-primary bg-primary/10"
                : failed
                  ? "border-destructive bg-destructive/5"
                  : "border-border hover:bg-muted/40"
            }`}
            type="button"
            onClick={() => onOpen(routine)}
          >
            <div className="flex items-start justify-between gap-2">
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium">
                  {routine.name}
                </span>
                <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">
                  agent: {routine.sessionLabel ?? (routine.session ? "unlabelled" : "unbound")}
                </span>
              </span>
              <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                {routine.cron}
              </span>
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-1">
              <FreezeBadge frozen={routine.frozen} />
              {routine.editedSinceFreeze && <EditedSinceFreezeBadge compact />}
              <StateBadge enabled={routine.enabled} />
            </div>
            <div
              className={`mt-2 flex items-center justify-between gap-2 text-[10px] ${
                failed ? "text-destructive" : "text-muted-foreground"
              }`}
            >
              <span>{routine.newLeads} open</span>
              <span>
                {routine.sentToday}/{routine.dailyCap} sent
              </span>
              <span>{routine.lastRun?.status ?? "not run"}</span>
            </div>
          </button>
        );
      })}
    </div>
  );
}

function RoutineEditor({
  routine,
  worktreeId,
  onCancel,
  onSaved,
}: {
  routine: Routine | null;
  worktreeId: number;
  onCancel: () => void;
  onSaved: (routine: Routine) => Promise<void>;
}) {
  const formKey = workbenchStateKey(routine?.id ?? "new");
  const stored = panelViewState(worktreeId).forms[formKey];
  const reviewedUpdatedAt = stored?.reviewedUpdatedAt ?? routine?.updatedAt ?? null;
  const [value, setValueState] = useState<RoutineForm>(
    stored?.value ??
      (routine
        ? {
            name: routine.name,
            cron: routine.cron,
            orderText: routine.orderText,
            session: routine.session ?? "",
            sessionLabel: routine.sessionLabel ?? "",
            dailyCap: routine.dailyCap,
            verbatimTerms: routine.verbatimTerms,
            blockedTopics: routine.blockedTopics.join("\n"),
            requiredDisclosure: routine.requiredDisclosure ?? "",
            keywords: routine.keywords
              ? Object.entries(routine.keywords).map(([term, weight], id) => ({
                  id,
                  term,
                  weight: String(weight),
                }))
              : [],
            scoreFloor: routine.scoreFloor?.toString() ?? "",
          }
        : EMPTY_FORM),
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hasKeywords = value.keywords.some(({ term }) => term.trim());
  const setValue: React.Dispatch<React.SetStateAction<RoutineForm>> = (next) => {
    setValueState((current) => {
      const resolved =
        typeof next === "function"
          ? (next as (current: RoutineForm) => RoutineForm)(current)
          : next;

      updatePanelViewState(worktreeId, (panel) => ({
        ...panel,
        forms: {
          ...panel.forms,
          [formKey]: {
            value: resolved,
            reviewedUpdatedAt,
          },
        },
      }));

      return resolved;
    });
  };
  const clearDraft = () => {
    updatePanelViewState(worktreeId, (panel) => {
      const forms = { ...panel.forms };

      delete forms[formKey];

      return { ...panel, forms };
    });
  };
  const cancel = () => {
    clearDraft();
    onCancel();
  };

  const save = async () => {
    setSaving(true);
    try {
      const keywords = serializeKeywordWeights(value.keywords);
      const body = {
        name: value.name,
        cron: value.cron,
        orderText: value.orderText,
        session: value.session.trim() || null,
        sessionLabel: value.sessionLabel.trim() || null,
        dailyCap: value.dailyCap,
        verbatimTerms: value.verbatimTerms,
        blockedTopics: value.blockedTopics
          .split("\n")
          .map((entry) => entry.trim())
          .filter(Boolean),
        requiredDisclosure: value.requiredDisclosure.trim() || null,
        keywords,
        scoreFloor:
          keywords && value.scoreFloor.trim() ? Number(value.scoreFloor) : null,
        ...(routine ? { reviewedUpdatedAt } : {}),
      };

      const result = await request<{ routine: Routine }>(
        routine ? `/api/mailarr/routines/${routine.id}` : "/api/mailarr/routines",
        {
          method: routine ? "PUT" : "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      clearDraft();
      await onSaved(result.routine);
    } catch (nextError) {
      setError(message(nextError));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex h-full flex-col gap-2 overflow-auto p-3 text-foreground">
      <Header
        title={routine ? `Edit ${routine.name}` : "New routine"}
        onBack={cancel}
      />
      {error && <Notice tone="error">{error}</Notice>}
      <FormSection title="Basics">
        <Field label="Name">
          <input
            className={INPUT_CLASS}
            value={value.name}
            onChange={(event) => setValue({ ...value, name: event.target.value })}
          />
        </Field>
        <div className="grid grid-cols-2 gap-2">
          <Field label="Cron">
            <input
              className={INPUT_CLASS}
              value={value.cron}
              onChange={(event) => setValue({ ...value, cron: event.target.value })}
            />
          </Field>
          <Field label="Daily cap">
            <input
              className={INPUT_CLASS}
              type="number"
              min={1}
              value={value.dailyCap}
              onChange={(event) =>
                setValue({ ...value, dailyCap: Number(event.target.value) })
              }
            />
          </Field>
        </div>
      </FormSection>

      <FormSection title="Agent">
        <Field
          label="Session id"
          helper="which session's agent executes this routine (empty = any)"
        >
          <input
            className={INPUT_CLASS}
            value={value.session}
            onChange={(event) =>
              setValue({ ...value, session: event.target.value })
            }
          />
        </Field>
        <Field
          label="Session label"
          helper="describe the agent so the card shows it"
        >
          <input
            className={INPUT_CLASS}
            value={value.sessionLabel}
            onChange={(event) =>
              setValue({ ...value, sessionLabel: event.target.value })
            }
          />
        </Field>
      </FormSection>

      <FormSection title="Order">
        <Field label="Instructions">
          <textarea
            className={INPUT_CLASS}
            rows={6}
            value={value.orderText}
            onChange={(event) =>
              setValue({ ...value, orderText: event.target.value })
            }
          />
        </Field>
      </FormSection>

      <FormSection title="Guards">
        <Field
          label="Verbatim terms"
          helper="inserted verbatim at {{TERMS}}; the only place digits are allowed"
        >
          <textarea
            className={INPUT_CLASS}
            rows={3}
            value={value.verbatimTerms}
            onChange={(event) =>
              setValue({ ...value, verbatimTerms: event.target.value })
            }
          />
        </Field>
        <Field
          label="Blocked topics"
          helper="one per line; outreach containing a blocked topic is rejected"
        >
          <textarea
            className={INPUT_CLASS}
            rows={3}
            value={value.blockedTopics}
            onChange={(event) =>
              setValue({ ...value, blockedTopics: event.target.value })
            }
          />
        </Field>
        <Field
          label="Required disclosure"
          helper="must appear exactly in every first-contact message"
        >
          <input
            className={INPUT_CLASS}
            value={value.requiredDisclosure}
            onChange={(event) =>
              setValue({ ...value, requiredDisclosure: event.target.value })
            }
          />
        </Field>
      </FormSection>

      <FormSection title="Scoring">
        <div className="flex items-center justify-between gap-2">
          <p className="text-xs font-medium text-foreground">Keyword weights</p>
          <button
            className="flex items-center gap-1 rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground outline-none hover:bg-muted focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
            type="button"
            onClick={() =>
              setValue((current) => ({
                ...current,
                keywords: [
                  ...current.keywords,
                  {
                    id:
                      current.keywords.reduce(
                        (highest, keyword) => Math.max(highest, keyword.id),
                        -1,
                      ) + 1,
                    term: "",
                    weight: "1",
                  },
                ],
              }))
            }
          >
            <Plus size={13} />
            Add keyword
          </button>
        </div>
        {value.keywords.length === 0 && (
          <p className="text-xs text-muted-foreground">
            No keyword weights defined.
          </p>
        )}
        {value.keywords.map((keyword) => (
          <div key={keyword.id} className="flex items-end gap-2">
            <Field label="Term">
              <input
                className={INPUT_CLASS}
                value={keyword.term}
                onChange={(event) =>
                  setValue((current) => ({
                    ...current,
                    keywords: current.keywords.map((entry) =>
                      entry.id === keyword.id
                        ? { ...entry, term: event.target.value }
                        : entry,
                    ),
                  }))
                }
              />
            </Field>
            <div className="w-20 shrink-0">
              <Field label="Weight">
                <input
                  className={INPUT_CLASS}
                  type="number"
                  step="any"
                  value={keyword.weight}
                  onChange={(event) =>
                    setValue((current) => ({
                      ...current,
                      keywords: current.keywords.map((entry) =>
                        entry.id === keyword.id
                          ? { ...entry, weight: event.target.value }
                          : entry,
                      ),
                    }))
                  }
                />
              </Field>
            </div>
            <button
              className="shrink-0 rounded-md border border-border bg-background p-2 text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
              type="button"
              title="Remove keyword"
              onClick={() =>
                setValue((current) => ({
                  ...current,
                  keywords: current.keywords.filter(
                    (entry) => entry.id !== keyword.id,
                  ),
                }))
              }
            >
              <Trash2 size={14} />
            </button>
          </div>
        ))}
        <Field
          label="Score floor"
          helper={
            hasKeywords
              ? "items scoring below this value are dropped"
              : "add at least one keyword to enable the score floor"
          }
        >
          <div className="w-24">
            <input
              className={INPUT_CLASS}
              type="number"
              value={value.scoreFloor}
              disabled={!hasKeywords}
              onChange={(event) =>
                setValue({ ...value, scoreFloor: event.target.value })
              }
            />
          </div>
        </Field>
      </FormSection>
      <button
        className="flex items-center justify-center gap-2 rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50"
        onClick={() => void save()}
        disabled={saving}
      >
        <Save size={15} />
        {saving ? "Saving..." : "Save routine"}
      </button>
    </div>
  );
}

function RoutineWorkbench({
  initialTarget,
  onBack,
  onTargetChanged,
  worktreeId,
}: {
  initialTarget: WorkbenchTarget;
  onBack?: () => Promise<void>;
  onTargetChanged?: (target: WorkbenchTarget) => void;
  worktreeId: number;
}) {
  const restored =
    panelViewState(worktreeId).workbenches[workbenchStateKey(initialTarget)] ??
    defaultWorkbenchState(initialTarget);
  const [routineId, setRoutineId] = useState<number | null>(
    initialTarget === "new" ? null : initialTarget,
  );
  const [pipeline, setPipeline] = useState<Pipeline | null>(null);
  const [stage, setStage] = useState<"all" | Stage>(restored.stage);
  const [expanded, setExpanded] = useState<number | null>(
    restored.expandedItemId,
  );
  const [error, setError] = useState<string | null>(null);
  const [reviewingFreeze, setReviewingFreeze] = useState(
    restored.reviewingFreeze,
  );
  const [briefingExpanded, setBriefingExpanded] = useState(
    restored.briefingExpanded,
  );
  const [view, setView] = useState<"pipeline" | "edit">(restored.view);
  const rememberWorkbench = (
    target: WorkbenchTarget,
    patch: Partial<WorkbenchViewState>,
  ) => {
    updatePanelViewState(worktreeId, (current) => ({
      ...current,
      workbenches: {
        ...current.workbenches,
        [workbenchStateKey(target)]: {
          ...(current.workbenches[workbenchStateKey(target)] ??
            defaultWorkbenchState(target)),
          ...patch,
        },
      },
    }));
  };
  const currentTarget = (): WorkbenchTarget => routineId ?? "new";
  const rememberStage = (nextStage: "all" | Stage) => {
    setStage(nextStage);
    rememberWorkbench(currentTarget(), { stage: nextStage });
  };
  const rememberExpanded = (itemId: number | null) => {
    setExpanded(itemId);
    rememberWorkbench(currentTarget(), { expandedItemId: itemId });
  };
  const rememberReviewingFreeze = (reviewing: boolean) => {
    setReviewingFreeze(reviewing);
    rememberWorkbench(currentTarget(), { reviewingFreeze: reviewing });
  };
  const rememberBriefingExpanded = (expanded: boolean) => {
    setBriefingExpanded(expanded);
    rememberWorkbench(currentTarget(), { briefingExpanded: expanded });
  };
  const rememberView = (nextView: "pipeline" | "edit") => {
    setView(nextView);
    rememberWorkbench(currentTarget(), { view: nextView });
  };

  const load = async () => {
    if (routineId === null) return;

    try {
      const nextPipeline = await request<Pipeline>(
        `/api/mailarr/routines/${routineId}/pipeline?stage=${stage}`,
      );
      setPipeline(nextPipeline);
      setError(null);
    } catch (nextError) {
      setError(message(nextError));
    }
  };

  const reviewFreeze = async () => {
    if (routineId === null) return;

    try {
      const result = await request<{ routine: Routine }>(
        `/api/mailarr/routines/${routineId}`,
      );

      setPipeline((current) =>
        current
          ? {
              ...current,
              routine: { ...current.routine, ...result.routine },
            }
          : current,
      );
      rememberReviewingFreeze(true);
      setError(null);
    } catch (nextError) {
      setError(message(nextError));
    }
  };

  useEffect(() => {
    void load();
  }, [routineId, stage]);

  if (routineId === null) {
    return (
      <RoutineEditor
        worktreeId={worktreeId}
        routine={null}
        onCancel={() => {
          if (onBack) {
            void onBack();
          } else {
            closeRoutineWorkbench(worktreeId, "routine:new");
          }
        }}
        onSaved={async (routine) => {
          setRoutineId(routine.id);
          setView("pipeline");
          updatePanelViewState(worktreeId, (current) => {
            const workbenches = { ...current.workbenches };

            delete workbenches.new;
            workbenches[workbenchStateKey(routine.id)] = defaultWorkbenchState(
              routine.id,
            );

            return { ...current, workbenches };
          });
          onTargetChanged?.(routine.id);
          if (openRoutineWorkbench(worktreeId, routine)) {
            closeRoutineWorkbench(worktreeId, "routine:new");
          }
        }}
      />
    );
  }

  if (!pipeline) {
    return (
      <div className="p-4">
        {error ? (
          <Notice tone="error">{error}</Notice>
        ) : (
          <p className="text-sm text-muted-foreground">Loading workbench...</p>
        )}
      </div>
    );
  }

  if (reviewingFreeze) {
    return (
      <FreezeReview
        error={error}
        routine={pipeline.routine}
        onCancel={() => {
          rememberReviewingFreeze(false);
          setError(null);
        }}
        onConfirm={() =>
          mutate(
            `/api/mailarr/routines/${pipeline.routine.id}/freeze`,
            {
              frozen: true,
              reviewedUpdatedAt: pipeline.routine.updatedAt,
            },
            async () => {
              rememberReviewingFreeze(false);
              await load();
            },
            setError,
          )
        }
      />
    );
  }

  if (view === "edit") {
    return (
      <RoutineEditor
        key={`${pipeline.routine.id}:${pipeline.routine.updatedAt}`}
        worktreeId={worktreeId}
        routine={pipeline.routine}
        onCancel={() => rememberView("pipeline")}
        onSaved={async (routine) => {
          setPipeline((current) =>
            current ? { ...current, routine: { ...current.routine, ...routine } } : current,
          );
          rememberView("pipeline");
          await load();
        }}
      />
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 overflow-auto p-4 text-foreground">
      {error && <Notice tone="error">{error}</Notice>}
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border pb-4">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            {onBack && (
              <IconButton
                title="Back to routines"
                onClick={() => void onBack()}
                icon={<ArrowLeft size={15} />}
              />
            )}
            <h2 className="text-lg font-semibold">{pipeline.routine.name}</h2>
            <StateBadge enabled={pipeline.routine.enabled} />
            <FreezeBadge frozen={pipeline.routine.frozen} />
            {pipeline.routine.editedSinceFreeze && (
              <EditedSinceFreezeBadge />
            )}
          </div>
          <p className="mt-1 font-mono text-xs text-muted-foreground">
            {pipeline.routine.cron}
          </p>
          <p className="mt-2 text-sm text-muted-foreground">
            Daily send cap: {pipeline.routine.dailyCap}
          </p>
          {!pipeline.routine.frozen && (
            <p className="mt-2 text-sm text-amber-500">
              Sends are disabled while this routine is unlocked.
            </p>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Toggle
            checked={pipeline.routine.enabled}
            label="Enabled"
            onChange={(enabled) =>
              void mutate(
                `/api/mailarr/routines/${pipeline.routine.id}/toggle`,
                { enabled },
                load,
                setError,
              )
            }
          />
          <button
            className="flex items-center gap-2 rounded-md border border-border bg-background px-3 py-2 text-sm outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50"
            type="button"
            onClick={() => rememberView("edit")}
          >
            <Settings2 size={15} />
            Edit routine
          </button>
          <button
            className="rounded-md border border-border bg-background px-3 py-2 text-sm outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50"
            type="button"
            onClick={() =>
              pipeline.routine.frozen
                ? void mutate(
                    `/api/mailarr/routines/${pipeline.routine.id}/freeze`,
                    { frozen: false },
                    load,
                    setError,
                  )
                : void reviewFreeze()
            }
          >
            {pipeline.routine.frozen ? "Unfreeze" : "Review and freeze"}
          </button>
          <button
            className="flex items-center gap-2 rounded-md border border-border bg-background px-3 py-2 text-sm outline-none hover:bg-muted focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-background"
            type="button"
            disabled={pipeline.routine.hasPendingRun}
            title={
              pipeline.routine.hasPendingRun
                ? "A run is already pending for this routine"
                : "Run now"
            }
            onClick={() =>
              void mutate(
                `/api/mailarr/routines/${pipeline.routine.id}/run`,
                {},
                load,
                setError,
              )
            }
          >
            <Play size={15} />
            Run now
          </button>
          {pipeline.routine.pendingRun && (
            <>
              <span className="text-xs text-muted-foreground">
                pending {pendingAge(pipeline.routine.pendingRun.createdAt)}
              </span>
              <button
                className="flex items-center gap-2 rounded-md border border-destructive/50 px-3 py-2 text-sm text-destructive outline-none hover:bg-destructive/10 focus-visible:ring-3 focus-visible:ring-ring/50"
                type="button"
                onClick={() =>
                  void mutate(
                    `/api/mailarr/routines/${pipeline.routine.id}/cancel-pending`,
                    {},
                    load,
                    setError,
                  )
                }
              >
                <XCircle size={15} />
                Cancel pending
              </button>
              {pipeline.routine.pendingRunCount > 1 && (
                <button
                  className="rounded-md border border-destructive/50 px-3 py-2 text-sm text-destructive outline-none hover:bg-destructive/10 focus-visible:ring-3 focus-visible:ring-ring/50"
                  type="button"
                  onClick={() =>
                    void mutate(
                      `/api/mailarr/routines/${pipeline.routine.id}/cancel-pending`,
                      { all: true },
                      load,
                      setError,
                    )
                  }
                >
                  Cancel all ({pipeline.routine.pendingRunCount})
                </button>
              )}
            </>
          )}
          <button
            className="flex items-center gap-2 rounded-md border border-border bg-background px-3 py-2 text-sm outline-none hover:bg-muted focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
            type="button"
            onClick={() => void load()}
          >
            <RefreshCw size={15} />
            Refresh
          </button>
        </div>
      </div>

      <div style={{ flexShrink: 0 }} className="flex gap-1 overflow-x-auto">
        {STAGES.map((entry) => (
          <button
            key={entry}
            style={{ padding: "4px 12px", fontSize: 12, lineHeight: "18px" }}
            className={`inline-flex flex-none items-center gap-1 whitespace-nowrap rounded-full border ${
              stage === entry
                ? "border-primary bg-primary text-primary-foreground"
                : "border-border text-muted-foreground hover:text-foreground"
            }`}
            type="button"
            onClick={() => rememberStage(entry)}
          >
            <span>{entry}</span>
            <span className={stage === entry ? "opacity-80" : "opacity-60"}>
              {pipeline.counts[entry]}
            </span>
          </button>
        ))}
      </div>

      <div style={{ flexShrink: 0 }} className="overflow-x-auto rounded-md border border-border bg-background">
        <div style={ITEM_GRID} className="gap-3 bg-muted/50 px-3 py-2 text-xs font-medium text-muted-foreground">
          <span />
          <span>Company</span>
          <span>Role</span>
          <span>Rate</span>
          <span>Stage</span>
          <span>Email</span>
          <span>Source</span>
        </div>
        {pipeline.items.map((item) => (
          <div key={item.id} className="border-t border-border">
            <button
              style={ITEM_GRID}
              className="w-full gap-3 px-3 py-3 text-left text-sm outline-none hover:bg-muted/30 focus-visible:bg-muted/30"
              type="button"
              onClick={() =>
                rememberExpanded(expanded === item.id ? null : item.id)
              }
            >
              {expanded === item.id ? (
                <ChevronDown size={16} className="text-muted-foreground" />
              ) : (
                <ChevronRight size={16} className="text-muted-foreground" />
              )}
              <span className="truncate font-medium">{item.company}</span>
              <span className="truncate">{item.role}</span>
              <span className="truncate text-muted-foreground">
                {item.rateInfo || "Not listed"}
              </span>
              <span className="text-muted-foreground">{item.stage}</span>
              <EmailStateBadge item={item} />
              <span className="truncate text-muted-foreground">{item.source}</span>
            </button>
            {expanded === item.id && <PipelineItemDetail item={item} />}
          </div>
        ))}
        {pipeline.items.length === 0 && (
          <p className="border-t border-border p-6 text-center text-sm text-muted-foreground">
            No items in this stage.
          </p>
        )}
      </div>

      <div style={{ flexShrink: 0 }} className="grid gap-4">
        <BriefingSection
          briefing={pipeline.briefing}
          expanded={briefingExpanded}
          onExpandedChange={rememberBriefingExpanded}
        />

        <div className="grid gap-4">
          <section className="rounded-md border border-border bg-background p-4">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Agent binding
            </h3>
            {pipeline.routine.session ? (
              <>
                <p className="mt-3 text-sm font-medium">
                  {pipeline.routine.sessionLabel ?? "Unlabelled agent"}
                </p>
                <p className="mt-1 break-all font-mono text-xs text-muted-foreground">
                  {pipeline.routine.session}
                </p>
              </>
            ) : (
              <p className="mt-3 text-sm text-muted-foreground">
                Any available agent may run this routine.
              </p>
            )}
          </section>

          <section className="rounded-md border border-border bg-background p-4">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Sources
            </h3>
            {pipeline.sources.length === 0 ? (
              <p className="mt-3 text-sm text-muted-foreground">
                No sources configured.
              </p>
            ) : (
              <div className="mt-3 space-y-3">
                {[...pipeline.sources]
                  .sort(
                    (left, right) =>
                      SOURCE_STATUS_ORDER[left.status] -
                        SOURCE_STATUS_ORDER[right.status] ||
                      left.name.localeCompare(right.name),
                  )
                  .map((source) => (
                    <div key={source.name} className="text-sm">
                      <div className="flex items-center gap-2">
                        <a
                          className="min-w-0 flex-1 truncate font-medium underline"
                          href={source.url}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {source.name}
                        </a>
                        <span
                          className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-medium ${SOURCE_STATUS_CLASS[source.status]}`}
                        >
                          {source.status}
                        </span>
                      </div>
                      {source.notes && (
                        <p className="mt-1 text-xs text-muted-foreground">
                          {source.notes}
                        </p>
                      )}
                    </div>
                  ))}
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

function BriefingSection({
  briefing,
  expanded,
  onExpandedChange,
}: {
  briefing: Pipeline["briefing"];
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
}) {
  return (
    <section className="self-start overflow-hidden rounded-md border border-border bg-background">
      <button
        className="flex w-full items-center gap-3 px-4 py-3 text-left outline-none hover:bg-muted/30 focus-visible:bg-muted/30"
        type="button"
        onClick={() => briefing && onExpandedChange(!expanded)}
        aria-expanded={briefing ? expanded : undefined}
      >
        {briefing ? (
          expanded ? (
            <ChevronDown size={16} className="shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight size={16} className="shrink-0 text-muted-foreground" />
          )
        ) : (
          <span className="w-4 shrink-0" />
        )}
        <span className="min-w-0 flex-1">
          <span className="block text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Latest briefing
          </span>
          <span className="mt-1 block truncate text-sm text-foreground">
            {briefing ? briefingSummary(briefing.markdown) : "No briefing posted yet."}
          </span>
        </span>
        {briefing && (
          <span className="shrink-0 text-xs text-muted-foreground">
            {new Date(briefing.createdAt).toLocaleString()}
          </span>
        )}
      </button>
      {briefing && expanded && (
        <div className="border-t border-border">
          <BriefingMarkdown markdown={briefing.markdown} />
        </div>
      )}
    </section>
  );
}

export function BriefingMarkdown({ markdown }: { markdown: string }) {
  const MarkdownView = getHostMarkdownView();

  return MarkdownView ? (
    <MarkdownView
      content={markdown}
      mode="rendered"
      preset="docs"
      className="text-sm"
    />
  ) : (
    <MinimalMarkdown markdown={markdown} />
  );
}

function getHostMarkdownView():
  | React.ComponentType<{
      content: string;
      mode?: "rendered" | "source";
      preset?: "docs" | "chat";
      className?: string;
    }>
  | null {
  if (typeof window === "undefined") return null;

  return (
    window as typeof window & {
      __QUBE_SHARED__?: {
        ui?: {
          MarkdownView?: React.ComponentType<{
            content: string;
            mode?: "rendered" | "source";
            preset?: "docs" | "chat";
            className?: string;
          }>;
        };
      };
    }
  ).__QUBE_SHARED__?.ui?.MarkdownView ?? null;
}

function MinimalMarkdown({ markdown }: { markdown: string }) {
  const lines = markdown.split(/\r?\n/u);
  const blocks: React.ReactNode[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index].trim();

    if (!line) {
      index += 1;
      continue;
    }

    const heading = /^(#{1,6})\s+(.+)$/u.exec(line);

    if (heading) {
      const level = heading[1].length;
      blocks.push(
        <div
          key={`heading:${index}`}
          className={level <= 2 ? "text-base font-semibold" : "text-sm font-semibold"}
          role="heading"
          aria-level={level}
        >
          {renderInlineMarkdown(heading[2], `heading:${index}`)}
        </div>,
      );
      index += 1;
      continue;
    }

    const list = /^(\d+\.\s+|[-*+]\s+)(.+)$/u.exec(line);

    if (list) {
      const ordered = /^\d+\./u.test(list[1]);
      const items: React.ReactNode[] = [];

      while (index < lines.length) {
        const next = /^(\d+\.\s+|[-*+]\s+)(.+)$/u.exec(lines[index].trim());

        if (!next || /^\d+\./u.test(next[1]) !== ordered) break;
        items.push(
          <li key={`item:${index}`}>
            {renderInlineMarkdown(next[2], `item:${index}`)}
          </li>,
        );
        index += 1;
      }

      blocks.push(
        ordered ? (
          <ol key={`list:${index}`} className="list-decimal space-y-1 pl-5">
            {items}
          </ol>
        ) : (
          <ul key={`list:${index}`} className="list-disc space-y-1 pl-5">
            {items}
          </ul>
        ),
      );
      continue;
    }

    const paragraph: string[] = [];

    while (
      index < lines.length &&
      lines[index].trim() &&
      !/^(#{1,6})\s+/u.test(lines[index].trim()) &&
      !/^(\d+\.\s+|[-*+]\s+)/u.test(lines[index].trim())
    ) {
      paragraph.push(lines[index].trim());
      index += 1;
    }

    blocks.push(
      <p key={`paragraph:${index}`}>
        {renderInlineMarkdown(paragraph.join(" "), `paragraph:${index}`)}
      </p>,
    );
  }

  return (
    <div className="space-y-3 px-4 py-3 text-sm leading-relaxed text-foreground">
      {blocks}
    </div>
  );
}

function renderInlineMarkdown(text: string, key: string): React.ReactNode[] {
  const tokens = text.split(/(`[^`]+`|\*\*[^*]+\*\*|__[^_]+__|\*[^*]+\*|_[^_]+_)/gu);

  return tokens.filter(Boolean).map((token, index) => {
    const tokenKey = `${key}:${index}`;

    if (token.startsWith("`") && token.endsWith("`")) {
      return (
        <code key={tokenKey} className="rounded bg-muted px-1 py-0.5 font-mono text-xs">
          {token.slice(1, -1)}
        </code>
      );
    }
    if (
      (token.startsWith("**") && token.endsWith("**")) ||
      (token.startsWith("__") && token.endsWith("__"))
    ) {
      return <strong key={tokenKey}>{token.slice(2, -2)}</strong>;
    }
    if (
      (token.startsWith("*") && token.endsWith("*")) ||
      (token.startsWith("_") && token.endsWith("_"))
    ) {
      return <em key={tokenKey}>{token.slice(1, -1)}</em>;
    }

    return token;
  });
}

function EmailStateBadge({ item }: { item: Item }) {
  const sent = Boolean(item.sentPitch || item.sentSubject);
  const drafted = Boolean(item.draftPitch || item.draftSubject);

  if (!sent && !drafted) {
    return <span className="text-xs text-muted-foreground">none</span>;
  }

  return (
    <span
      className={`w-fit rounded-full border px-2 py-0.5 text-[10px] font-medium ${
        sent
          ? "border-emerald-500/50 text-emerald-500"
          : "border-amber-500/50 text-amber-500"
      }`}
    >
      {sent ? "sent" : "draft"}
    </span>
  );
}

function PipelineItemDetail({ item }: { item: Item }) {
  const sent = Boolean(item.sentPitch || item.sentSubject);
  const subject = sent ? item.sentSubject : item.draftSubject;
  const body = sent ? item.sentPitch : item.draftPitch;

  return (
    <div className="grid gap-4 border-t border-border bg-muted/15 px-10 py-4 text-sm md:grid-cols-2">
      <PipelineField label="Score" value={String(item.score)} />
      <PipelineField
        label="Contact"
        value={item.contactEmail ?? "No contact email"}
      />
      <PipelineField label="Fit notes" value={item.fitNotes ?? "None"} />
      <PipelineField label="Drop reason" value={item.dropReason ?? "None"} />
      <section className="rounded-md border border-border bg-background p-4 md:col-span-2">
        <div className="mb-4 flex items-center justify-between gap-2">
          <h3 className="text-sm font-semibold">
            {sent ? "Sent email" : "Draft email"}
          </h3>
          <EmailStateBadge item={item} />
        </div>
        <PipelineField label="Subject" value={subject ?? "not drafted yet"} />
        <div className="mt-4">
          <PipelineField label="Body" value={body ?? "not drafted yet"} />
        </div>
      </section>
      <a
        className="text-primary underline"
        href={item.url}
        target="_blank"
        rel="noreferrer"
      >
        Open source posting
      </a>
    </div>
  );
}

function PipelineField({
  label,
  value,
  wide = false,
}: {
  label: string;
  value: string;
  wide?: boolean;
}) {
  return (
    <div className={wide ? "md:col-span-2" : undefined}>
      <p className="mb-1 text-xs font-medium text-muted-foreground">{label}</p>
      <p className="whitespace-pre-wrap">{value}</p>
    </div>
  );
}

function Header({ title, onBack }: { title: string; onBack: () => void }) {
  return (
    <div className="flex items-center gap-2">
      <IconButton title="Back" onClick={onBack} icon={<ArrowLeft size={15} />} />
      <h2 className="text-sm font-semibold">{title}</h2>
    </div>
  );
}

function FreezeBadge({ frozen }: { frozen: boolean }) {
  return (
    <span
      className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-medium ${
        frozen
          ? "border-sky-500/50 text-sky-500"
          : "border-amber-500/50 text-amber-500"
      }`}
    >
      {frozen ? "frozen" : "unlocked"}
    </span>
  );
}

function StateBadge({ enabled }: { enabled: boolean }) {
  return (
    <span
      className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-medium ${
        enabled
          ? "border-emerald-500/50 text-emerald-500"
          : "border-border text-muted-foreground"
      }`}
    >
      {enabled ? "enabled" : "disabled"}
    </span>
  );
}

function EditedSinceFreezeBadge({ compact = false }: { compact?: boolean }) {
  return (
    <span className="shrink-0 rounded-full border border-amber-500/50 px-2 py-0.5 text-[10px] font-medium text-amber-500">
      {compact ? "edited" : "content edited since last freeze"}
    </span>
  );
}

function FreezeReview({
  error,
  routine,
  onCancel,
  onConfirm,
}: {
  error: string | null;
  routine: Routine;
  onCancel: () => void;
  onConfirm: () => Promise<void>;
}) {
  const [confirming, setConfirming] = useState(false);
  const values = [
    ["order_text", routine.orderText],
    ["verbatim_terms", routine.verbatimTerms],
    ["blocked_topics", JSON.stringify(routine.blockedTopics, null, 2)],
    ["required_disclosure", routine.requiredDisclosure ?? "null"],
    ["keywords", JSON.stringify(routine.keywords, null, 2)],
    [
      "score_floor",
      routine.scoreFloor === null ? "null" : String(routine.scoreFloor),
    ],
  ] as const;
  const confirm = async () => {
    setConfirming(true);
    try {
      await onConfirm();
    } finally {
      setConfirming(false);
    }
  };

  return (
    <div className="flex h-full flex-col gap-4 overflow-auto p-4 text-foreground">
      <div>
        <h2 className="text-base font-semibold">Review and freeze {routine.name}</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Confirm the current agent-authorable content before enabling sends.
        </p>
        {routine.editedSinceFreeze && (
          <div className="mt-2">
            <EditedSinceFreezeBadge />
          </div>
        )}
      </div>
      {error && <Notice tone="error">{error}</Notice>}
      <div className="space-y-3">
        {values.map(([label, value]) => (
          <section
            key={label}
            className="rounded-md border border-border bg-background p-3"
          >
            <h3 className="text-xs font-semibold text-muted-foreground">{label}</h3>
            <pre className="mt-2 whitespace-pre-wrap break-words text-xs">{value}</pre>
          </section>
        ))}
      </div>
      <div className="flex justify-end gap-2 border-t border-border pt-3">
        <button
          className="rounded-md border border-border px-3 py-2 text-sm outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50"
          type="button"
          onClick={onCancel}
        >
          Cancel
        </button>
        <button
          className="rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
          type="button"
          disabled={confirming}
          onClick={() => void confirm()}
        >
          {confirming ? "Freezing..." : "Confirm freeze"}
        </button>
      </div>
    </div>
  );
}

function Toggle({
  checked,
  label,
  onChange,
}: {
  checked: boolean;
  label: string;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex items-center gap-2 text-xs">
      <input
        className="h-4 w-4 rounded border border-border bg-background accent-primary outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      {label}
    </label>
  );
}

function Field({
  label,
  helper,
  children,
}: {
  label: string;
  helper?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="flex min-w-0 flex-1 flex-col gap-1">
      <span className="text-xs font-medium text-foreground">{label}</span>
      {children}
      {helper && <span className="text-xs text-muted-foreground">{helper}</span>}
    </label>
  );
}

function FormSection({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-3 rounded-md border border-border bg-background p-3">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </h3>
      {children}
    </section>
  );
}

function IconButton({
  title,
  onClick,
  icon,
  disabled = false,
}: {
  title: string;
  onClick: () => void;
  icon: React.ReactNode;
  disabled?: boolean;
}) {
  return (
    <button
      className="rounded-md border border-border bg-background p-1.5 outline-none hover:bg-muted focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-background"
      onClick={onClick}
      disabled={disabled}
      title={title}
    >
      {icon}
    </button>
  );
}

function Notice({
  tone,
  children,
}: {
  tone: "error";
  children: React.ReactNode;
}) {
  return (
    <p
      className={
        tone === "error"
          ? "rounded-md border border-destructive p-2 text-xs text-destructive"
          : ""
      }
    >
      {children}
    </p>
  );
}

async function mutate(
  path: string,
  body: unknown,
  onDone: () => Promise<void>,
  setError: (value: string | null) => void,
) {
  try {
    await request(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    setError(null);
    await onDone();
  } catch (error) {
    setError(message(error));
  }
}

interface EditorTabsApi {
  open?: (
    worktreeId: number,
    spec: {
      ext: string;
      editor: string;
      key: string;
      title: string;
      payload: unknown;
    },
  ) => void;
  close?: (
    worktreeId: number,
    ref: {
      ext: string;
      editor: string;
      key: string;
    },
  ) => void;
  useActiveKey?: (
    worktreeId: number,
    ext: string,
    editor: string,
  ) => string | null;
}

function getEditorTabs(): EditorTabsApi | null {
  if (typeof window === "undefined") return null;

  return (
    window as typeof window & {
      __QUBE_SHARED__?: { editorTabs?: EditorTabsApi };
    }
  ).__QUBE_SHARED__?.editorTabs ?? null;
}

export function openRoutineWorkbench(
  worktreeId: number,
  routine: Pick<Routine, "id" | "name"> | null,
): boolean {
  const editorTabs = getEditorTabs();

  if (typeof editorTabs?.open !== "function") return false;

  try {
    editorTabs.open(worktreeId, {
      ext: "mailarr",
      editor: "workbench",
      key: routine ? `routine:${routine.id}` : "routine:new",
      title: routine?.name ?? "New routine",
      payload: routine ? { routineId: routine.id } : { mode: "new" },
    });

    return true;
  } catch {
    return false;
  }
}

function closeRoutineWorkbench(worktreeId: number, key: string): void {
  const close = getEditorTabs()?.close;

  if (typeof close !== "function") return;

  try {
    close(worktreeId, {
      ext: "mailarr",
      editor: "workbench",
      key,
    });
  } catch {
    return;
  }
}

export function workbenchTarget(payload: unknown): number | "new" | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  if ("mode" in payload && (payload as { mode: unknown }).mode === "new") {
    return "new";
  }

  if (!("routineId" in payload)) return null;

  const routineId = Number((payload as { routineId: unknown }).routineId);

  return Number.isInteger(routineId) && routineId > 0 ? routineId : null;
}

export function routineIdFromWorkbenchKey(key: string | null): number | null {
  if (!key?.startsWith("routine:")) return null;

  const routineId = Number(key.slice("routine:".length));

  return Number.isInteger(routineId) && routineId > 0 ? routineId : null;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default mailarr;
