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
  lastRun: Run | null;
  hasPendingRun: boolean;
  pendingRun: Run | null;
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
  draftPitch: string | null;
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
      id: "pipeline",
      icon: Mail,
      render: (_worktreeId, payload) => {
        const routineId = editorRoutineId(payload);

        return routineId ? (
          <PipelineEditor routineId={routineId} />
        ) : (
          <Notice tone="error">Invalid Mailarr pipeline payload.</Notice>
        );
      },
    },
  ],
};

function MailarrPanel({ worktreeId }: { worktreeId: number }) {
  const [routines, setRoutines] = useState<Routine[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [editing, setEditing] = useState<Routine | "new" | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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

  if (editing) {
    return (
      <RoutineEditor
        routine={editing === "new" ? null : editing}
        onCancel={() => setEditing(null)}
        onSaved={async () => {
          setEditing(null);
          await load();
        }}
      />
    );
  }

  if (selected !== null) {
    return (
      <RoutineDetail
        routineId={selected}
        onBack={() => {
          setSelected(null);
          void load();
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
          onClick={() => setEditing("new")}
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

      <div className="space-y-2 overflow-auto">
        {routines.map((routine) => (
          <div
            key={routine.id}
            className={`rounded-md border p-3 ${
              routine.lastRun?.status === "failed"
                ? "border-destructive"
                : "border-border"
            }`}
          >
            <button
              className="w-full text-left"
              onClick={() => {
                if (!openPipelineEditor(worktreeId, routine)) {
                  setSelected(routine.id);
                }
              }}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="flex min-w-0 items-center gap-2">
                  <span className="truncate text-sm font-medium">
                    {routine.name}
                  </span>
                  <FreezeBadge frozen={routine.frozen} />
                </span>
                <span className="text-[11px] text-muted-foreground">{routine.cron}</span>
              </div>
              {!routine.frozen && (
                <p className="mt-2 text-xs text-amber-500">
                  Sends are disabled while unlocked.
                </p>
              )}
              {routine.session ? (
                <p className="mt-2 text-xs font-medium text-foreground">
                  agent: {routine.sessionLabel ?? "unlabelled"} ({routine.session})
                </p>
              ) : (
                <p className="mt-2 text-xs text-muted-foreground">unbound</p>
              )}
              <div className="mt-2 grid grid-cols-3 gap-2 text-[11px] text-muted-foreground">
                <span>{routine.newLeads} open</span>
                <span>
                  {routine.sentToday}/{routine.dailyCap} today
                </span>
                <span>{routine.lastRun?.status ?? "not run"}</span>
              </div>
            </button>
            <div className="mt-3 flex items-center justify-between gap-2 border-t border-border pt-2">
              <div className="flex flex-wrap gap-3">
                <Toggle
                  checked={routine.enabled}
                  label="Enabled"
                  onChange={(enabled) =>
                    void mutate(
                      `/api/mailarr/routines/${routine.id}/toggle`,
                      { enabled },
                      load,
                      setError,
                    )
                  }
                />
                <Toggle
                  checked={routine.frozen}
                  label="Frozen"
                  onChange={(frozen) =>
                    void mutate(
                      `/api/mailarr/routines/${routine.id}/freeze`,
                      { frozen },
                      load,
                      setError,
                    )
                  }
                />
              </div>
              <div className="flex gap-1">
                <IconButton
                  title="Edit"
                  onClick={() => setEditing(routine)}
                  icon={<Settings2 size={14} />}
                />
                <IconButton
                  title={
                    routine.hasPendingRun
                      ? "A run is already pending for this routine"
                      : "Run now"
                  }
                  disabled={routine.hasPendingRun}
                  onClick={() =>
                    void mutate(
                      `/api/mailarr/routines/${routine.id}/run`,
                      {},
                      load,
                      setError,
                    )
                  }
                  icon={<Play size={14} />}
                />
                {routine.pendingRun && (
                  <>
                    <span className="self-center text-[11px] text-muted-foreground">
                      pending {pendingAge(routine.pendingRun.createdAt)}
                    </span>
                    <IconButton
                      title="Cancel pending run"
                      onClick={() =>
                        void mutate(
                          `/api/mailarr/routines/${routine.id}/cancel-pending`,
                          {},
                          load,
                          setError,
                        )
                      }
                      icon={<XCircle size={14} />}
                    />
                  </>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function RoutineEditor({
  routine,
  onCancel,
  onSaved,
}: {
  routine: Routine | null;
  onCancel: () => void;
  onSaved: () => Promise<void>;
}) {
  const [value, setValue] = useState<RoutineForm>(
    routine
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
      : EMPTY_FORM,
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hasKeywords = value.keywords.some(({ term }) => term.trim());

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
      };

      await request(
        routine ? `/api/mailarr/routines/${routine.id}` : "/api/mailarr/routines",
        {
          method: routine ? "PUT" : "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      await onSaved();
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
        onBack={onCancel}
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

function RoutineDetail({
  routineId,
  onBack,
}: {
  routineId: number;
  onBack: () => void;
}) {
  const [pipeline, setPipeline] = useState<Pipeline | null>(null);
  const [stage, setStage] = useState<"all" | Stage>("all");
  const [expanded, setExpanded] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    request<Pipeline>(
      `/api/mailarr/routines/${routineId}/pipeline?stage=${stage}`,
    )
      .then(setPipeline)
      .catch((nextError) => setError(message(nextError)));
  }, [routineId, stage]);

  return (
    <div className="flex h-full flex-col gap-3 overflow-auto p-3 text-foreground">
      <Header title={pipeline?.routine.name ?? "Routine"} onBack={onBack} />
      {error && <Notice tone="error">{error}</Notice>}
      {!pipeline && !error && (
        <p className="text-xs text-muted-foreground">Loading...</p>
      )}
      {pipeline && (
        <>
          <section className="rounded-md border border-border p-3">
            <h3 className="text-xs font-semibold uppercase tracking-wide">Sources</h3>
            {pipeline.sources.length === 0 ? (
              <p className="mt-2 text-xs text-muted-foreground">No sources configured.</p>
            ) : (
              <div className="mt-2 space-y-2">
                {[...pipeline.sources]
                  .sort(
                    (left, right) =>
                      SOURCE_STATUS_ORDER[left.status] -
                        SOURCE_STATUS_ORDER[right.status] ||
                      left.name.localeCompare(right.name),
                  )
                  .map((source) => (
                    <div key={source.name} className="text-xs">
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
                        <p className="text-muted-foreground">{source.notes}</p>
                      )}
                    </div>
                  ))}
              </div>
            )}
          </section>
          {pipeline.briefing && (
            <section className="rounded-md border border-border p-3">
              <h3 className="text-xs font-semibold uppercase tracking-wide">
                Latest briefing
              </h3>
              <pre className="mt-2 whitespace-pre-wrap text-xs text-muted-foreground">
                {pipeline.briefing.markdown}
              </pre>
            </section>
          )}
          <div className="flex gap-1 overflow-x-auto">
            {STAGES.map((entry) => (
              <button
                key={entry}
                className={`inline-flex flex-none items-center gap-1 whitespace-nowrap rounded-full border px-2.5 py-0.5 text-xs leading-5 ${
                  stage === entry
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-border text-muted-foreground"
                }`}
                onClick={() => setStage(entry)}
              >
                <span>{entry}</span>
                <span className={stage === entry ? "opacity-80" : "opacity-60"}>
                  {pipeline.counts[entry]}
                </span>
              </button>
            ))}
          </div>
          <div className="space-y-2">
            {pipeline.items.map((item) => (
              <button
                key={item.id}
                className="w-full rounded-md border border-border p-3 text-left"
                onClick={() => setExpanded(expanded === item.id ? null : item.id)}
              >
                <div className="flex justify-between gap-2">
                  <span className="text-sm font-medium">{item.company}</span>
                  <span className="text-[11px] text-muted-foreground">{item.stage}</span>
                </div>
                <p className="text-xs text-muted-foreground">{item.role}</p>
                {expanded === item.id && (
                  <div className="mt-3 space-y-2 border-t border-border pt-2 text-xs">
                    <p>Source: {item.source}</p>
                    <p>Score: {item.score}</p>
                    {item.contactEmail && <p>Contact: {item.contactEmail}</p>}
                    {item.fitNotes && <p>Notes: {item.fitNotes}</p>}
                    {item.dropReason && <p>Drop: {item.dropReason}</p>}
                    {(item.sentPitch ?? item.draftPitch) && (
                      <pre className="whitespace-pre-wrap rounded bg-muted p-2">
                        {item.sentPitch ?? item.draftPitch}
                      </pre>
                    )}
                  </div>
                )}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function PipelineEditor({ routineId }: { routineId: number }) {
  const [pipeline, setPipeline] = useState<Pipeline | null>(null);
  const [stage, setStage] = useState<"all" | Stage>("all");
  const [expanded, setExpanded] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
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

  useEffect(() => {
    void load();
  }, [routineId, stage]);

  if (error) {
    return (
      <div className="p-4">
        <Notice tone="error">{error}</Notice>
      </div>
    );
  }

  if (!pipeline) {
    return <p className="p-4 text-sm text-muted-foreground">Loading pipeline...</p>;
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 overflow-auto p-4 text-foreground">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border pb-4">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-lg font-semibold">{pipeline.routine.name}</h2>
            <span
              className={`rounded-full border px-2 py-0.5 text-[11px] font-medium ${
                pipeline.routine.enabled
                  ? "border-emerald-500/50 text-emerald-500"
                  : "border-border text-muted-foreground"
              }`}
            >
              {pipeline.routine.enabled ? "enabled" : "disabled"}
            </span>
            <FreezeBadge frozen={pipeline.routine.frozen} />
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

      <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(260px,1fr)]">
        <section className="rounded-md border border-border bg-background p-4">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Latest briefing
            </h3>
            {pipeline.briefing && (
              <span className="text-xs text-muted-foreground">
                {new Date(pipeline.briefing.createdAt).toLocaleString()}
              </span>
            )}
          </div>
          {pipeline.briefing ? (
            <div className="mt-3 whitespace-pre-wrap text-sm leading-relaxed">
              {pipeline.briefing.markdown}
            </div>
          ) : (
            <p className="mt-3 text-sm text-muted-foreground">
              No briefing posted yet.
            </p>
          )}
        </section>

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

      <div className="flex gap-1 overflow-x-auto">
        {STAGES.map((entry) => (
          <button
            key={entry}
            className={`inline-flex flex-none items-center gap-1 whitespace-nowrap rounded-full border px-3 py-1 text-xs ${
              stage === entry
                ? "border-primary bg-primary text-primary-foreground"
                : "border-border text-muted-foreground hover:text-foreground"
            }`}
            type="button"
            onClick={() => setStage(entry)}
          >
            <span>{entry}</span>
            <span className={stage === entry ? "opacity-80" : "opacity-60"}>
              {pipeline.counts[entry]}
            </span>
          </button>
        ))}
      </div>

      <div className="min-w-[760px] overflow-hidden rounded-md border border-border bg-background">
        <div className="grid grid-cols-[28px_1.1fr_1.4fr_0.8fr_0.7fr_120px] gap-3 bg-muted/50 px-3 py-2 text-xs font-medium text-muted-foreground">
          <span />
          <span>Company</span>
          <span>Role</span>
          <span>Rate</span>
          <span>Stage</span>
          <span>Source</span>
        </div>
        {pipeline.items.map((item) => (
          <div key={item.id} className="border-t border-border">
            <button
              className="grid w-full grid-cols-[28px_1.1fr_1.4fr_0.8fr_0.7fr_120px] gap-3 px-3 py-3 text-left text-sm outline-none hover:bg-muted/30 focus-visible:bg-muted/30"
              type="button"
              onClick={() => setExpanded(expanded === item.id ? null : item.id)}
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
    </div>
  );
}

function PipelineItemDetail({ item }: { item: Item }) {
  return (
    <div className="grid gap-4 border-t border-border bg-muted/15 px-10 py-4 text-sm md:grid-cols-2">
      <PipelineField label="Score" value={String(item.score)} />
      <PipelineField
        label="Contact"
        value={item.contactEmail ?? "No contact email"}
      />
      <PipelineField label="Fit notes" value={item.fitNotes ?? "None"} />
      <PipelineField label="Drop reason" value={item.dropReason ?? "None"} />
      <PipelineField
        label="Draft pitch"
        value={item.draftPitch ?? "None"}
        wide
      />
      <PipelineField
        label="Sent pitch"
        value={item.sentPitch ?? "None"}
        wide
      />
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

export function openPipelineEditor(
  worktreeId: number,
  routine: Pick<Routine, "id" | "name">,
): boolean {
  if (typeof window === "undefined") return false;

  const editorTabs = (
    window as typeof window & {
      __QUBE_SHARED__?: {
        editorTabs?: {
          open?: (
            id: number,
            spec: {
              ext: string;
              editor: string;
              key: string;
              title: string;
              payload: unknown;
            },
          ) => void;
        };
      };
    }
  ).__QUBE_SHARED__?.editorTabs;

  if (typeof editorTabs?.open !== "function") return false;

  try {
    editorTabs.open(worktreeId, {
      ext: "mailarr",
      editor: "pipeline",
      key: `routine:${routine.id}`,
      title: routine.name,
      payload: { routineId: routine.id },
    });

    return true;
  } catch {
    return false;
  }
}

export function editorRoutineId(payload: unknown): number | null {
  if (!payload || typeof payload !== "object" || !("routineId" in payload)) {
    return null;
  }

  const routineId = Number((payload as { routineId: unknown }).routineId);

  return Number.isInteger(routineId) && routineId > 0 ? routineId : null;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default mailarr;
