import { useEffect, useState } from "react";
import {
  ArrowLeft,
  Mail,
  Play,
  Plus,
  Save,
  Settings2,
  Trash2,
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
  dailyCap: number;
  verbatimTerms: string;
  blockedTopics: string[];
  requiredDisclosure: string | null;
  keywords: Record<string, number> | null;
  scoreFloor: number | null;
  enabled: boolean;
  lastRun: Run | null;
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

const mailarr: WebExtension = {
  id: "mailarr",
  panels: [
    {
      id: "mailarr",
      icon: Mail,
      title: "Mailarr",
      scope: "session",
      render: () => <MailarrPanel />,
    },
  ],
};

function MailarrPanel() {
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
            <button className="w-full text-left" onClick={() => setSelected(routine.id)}>
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-medium">{routine.name}</span>
                <span className="text-[11px] text-muted-foreground">{routine.cron}</span>
              </div>
              <div className="mt-2 grid grid-cols-3 gap-2 text-[11px] text-muted-foreground">
                <span>{routine.newLeads} open</span>
                <span>
                  {routine.sentToday}/{routine.dailyCap} today
                </span>
                <span>{routine.lastRun?.status ?? "not run"}</span>
              </div>
            </button>
            <div className="mt-3 flex items-center justify-between border-t border-border pt-2">
              <label className="flex items-center gap-2 text-xs">
                <input
                  className="h-4 w-4 rounded border border-border bg-background outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
                  style={{ accentColor: "var(--primary)" }}
                  type="checkbox"
                  checked={routine.enabled}
                  onChange={(event) =>
                    void mutate(
                      `/api/mailarr/routines/${routine.id}/toggle`,
                      { enabled: event.target.checked },
                      load,
                      setError,
                    )
                  }
                />
                Enabled
              </label>
              <div className="flex gap-1">
                <IconButton
                  title="Edit"
                  onClick={() => setEditing(routine)}
                  icon={<Settings2 size={14} />}
                />
                <IconButton
                  title="Run now"
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
                className={`rounded-full border px-2 py-1 text-[11px] ${
                  stage === entry
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-border"
                }`}
                onClick={() => setStage(entry)}
              >
                {entry} {pipeline.counts[entry]}
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

function Header({ title, onBack }: { title: string; onBack: () => void }) {
  return (
    <div className="flex items-center gap-2">
      <IconButton title="Back" onClick={onBack} icon={<ArrowLeft size={15} />} />
      <h2 className="text-sm font-semibold">{title}</h2>
    </div>
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
}: {
  title: string;
  onClick: () => void;
  icon: React.ReactNode;
}) {
  return (
    <button
      className="rounded-md border border-border bg-background p-1.5 outline-none hover:bg-muted focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
      onClick={onClick}
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

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default mailarr;
