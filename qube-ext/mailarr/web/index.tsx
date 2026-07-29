import { useEffect, useMemo, useState } from "react";
import {
  ArrowLeft,
  BriefcaseBusiness,
  ChevronDown,
  ChevronRight,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Save,
  X,
} from "lucide-react";
import {
  cn,
  projectBase,
  request,
  type WebExtension,
} from "@qube-code/extension-sdk/web";

type RunStatus = "pending" | "running" | "done" | "failed";
type Stage = "discovered" | "qualified" | "contacted" | "replied" | "dropped";

interface Run {
  id: number;
  status: RunStatus;
  createdAt: string;
  finishedAt: string | null;
  foundCount: number;
  qualifiedCount: number;
  sentCount: number;
  errorText: string | null;
}

interface Routine {
  id: number;
  name: string;
  cron: string;
  orderText: string;
  dailyCap: number;
  enabled: boolean;
  lastRun: Run | null;
  newLeads: number;
  sentToday: number;
}

interface Item {
  id: number;
  stage: Stage;
  company: string;
  role: string;
  rateInfo: string;
  source: string;
  url: string;
  contactEmail: string | null;
  score: number;
  fitNotes: string | null;
  draftPitch: string | null;
  sentPitch: string | null;
  dropReason: string | null;
  createdAt: string;
}

interface PipelinePayload {
  routine: Routine;
  counts: Record<"all" | Stage, number>;
  briefing: { markdown: string; createdAt: string } | null;
  items: Item[];
}

interface RoutineForm {
  id?: number;
  name: string;
  cron: string;
  orderText: string;
  dailyCap: number;
}

const EMPTY_FORM: RoutineForm = {
  name: "",
  cron: "0 9 * * *",
  orderText: "",
  dailyCap: 5,
};

const STAGES: Array<{ key: "all" | Stage; label: string }> = [
  { key: "all", label: "All" },
  { key: "discovered", label: "Discovered" },
  { key: "qualified", label: "Qualified" },
  { key: "contacted", label: "Contacted" },
  { key: "replied", label: "Replied" },
  { key: "dropped", label: "Dropped" },
];

function MailarrPanel({ worktreeId }: { worktreeId: number }) {
  const [routines, setRoutines] = useState<Routine[]>([]);
  const [inlineRoutineId, setInlineRoutineId] = useState<number | null>(null);
  const [form, setForm] = useState<RoutineForm | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const base = projectBase();

  const load = async () => {
    try {
      const payload = await request<{ routines: Routine[] }>("/api/mailarr/routines");
      setRoutines(payload.routines);
      setError("");
    } catch (caught) {
      setError(message(caught));
    }
  };

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 30_000);

    return () => clearInterval(timer);
  }, [base]);

  const mutate = async (action: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await action();
      await load();
      setError("");
    } catch (caught) {
      setError(message(caught));
    } finally {
      setBusy(false);
    }
  };

  const openRoutine = (routine: Routine) => {
    if (openPipelineEditor(worktreeId, routine)) return;

    setInlineRoutineId(routine.id);
  };

  if (inlineRoutineId !== null) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <button
          type="button"
          className="flex items-center gap-1 border-b border-border px-3 py-2 text-xs text-muted-foreground hover:text-foreground"
          onClick={() => setInlineRoutineId(null)}
        >
          <ArrowLeft className="size-3.5" />
          Routines
        </button>
        <PipelineView routineId={inlineRoutineId} />
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col text-xs">
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <div>
          <p className="text-sm font-semibold text-foreground">Mailarr</p>
          <p className="text-[11px] text-muted-foreground">Sebe outreach routines</p>
        </div>
        <div className="flex items-center gap-1">
          <IconButton label="Refresh" onClick={() => void load()}>
            <RefreshCw className="size-3.5" />
          </IconButton>
          <IconButton label="New routine" onClick={() => setForm({ ...EMPTY_FORM })}>
            <Plus className="size-3.5" />
          </IconButton>
        </div>
      </div>

      {error && (
        <div className="border-b border-red-500/30 bg-red-500/10 px-3 py-2 text-red-600">
          {error}
        </div>
      )}

      {form && (
        <RoutineEditor
          value={form}
          busy={busy}
          onChange={setForm}
          onCancel={() => setForm(null)}
          onSave={() =>
            void mutate(async () => {
              const path = form.id
                ? `/api/mailarr/routines/${form.id}`
                : "/api/mailarr/routines";
              await request(path, {
                method: form.id ? "PUT" : "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(form),
              });
              setForm(null);
            })
          }
        />
      )}

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        <div className="flex flex-col gap-2">
          {routines.map((routine) => (
            <RoutineRow
              key={routine.id}
              routine={routine}
              busy={busy}
              onOpen={() => openRoutine(routine)}
              onEdit={() =>
                setForm({
                  id: routine.id,
                  name: routine.name,
                  cron: routine.cron,
                  orderText: routine.orderText,
                  dailyCap: routine.dailyCap,
                })
              }
              onToggle={() =>
                void mutate(() =>
                  request(`/api/mailarr/routines/${routine.id}/toggle`, {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({ enabled: !routine.enabled }),
                  }),
                )
              }
              onRun={() =>
                void mutate(() =>
                  request(`/api/mailarr/routines/${routine.id}/run`, { method: "POST" }),
                )
              }
            />
          ))}
          {!routines.length && !error && (
            <p className="rounded-md border border-dashed border-border p-4 text-center text-muted-foreground">
              No routines yet.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

function RoutineRow({
  routine,
  busy,
  onOpen,
  onEdit,
  onToggle,
  onRun,
}: {
  routine: Routine;
  busy: boolean;
  onOpen: () => void;
  onEdit: () => void;
  onToggle: () => void;
  onRun: () => void;
}) {
  const failed = routine.lastRun?.status === "failed";

  return (
    <div
      className={cn(
        "rounded-md border bg-background p-2",
        failed ? "border-red-500/60 bg-red-500/5" : "border-border",
      )}
    >
      <button type="button" className="w-full text-left" onClick={onOpen}>
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="truncate font-medium text-foreground">{routine.name}</p>
            <p className="font-mono text-[10px] text-muted-foreground">{routine.cron}</p>
          </div>
          <span
            className={cn(
              "rounded px-1.5 py-0.5 text-[10px]",
              routine.enabled
                ? "bg-emerald-500/15 text-emerald-600"
                : "bg-muted text-muted-foreground",
            )}
          >
            {routine.enabled ? "enabled" : "disabled"}
          </span>
        </div>
        <div className="mt-2 grid grid-cols-2 gap-1 text-[10px] text-muted-foreground">
          <span>Last: {relativeTime(routine.lastRun?.finishedAt ?? routine.lastRun?.createdAt)}</span>
          <span className="text-right">New leads: {routine.newLeads}</span>
          <span>
            Sent today: {routine.sentToday}/{routine.dailyCap}
          </span>
          <span className="text-right capitalize">
            {routine.lastRun?.status ?? "never run"}
          </span>
        </div>
      </button>
      <div className="mt-2 flex items-center justify-end gap-1 border-t border-border pt-2">
        <label className="mr-auto flex cursor-pointer items-center gap-1 text-[10px] text-muted-foreground">
          <input
            type="checkbox"
            checked={routine.enabled}
            disabled={busy}
            onChange={onToggle}
          />
          Enabled
        </label>
        <IconButton label="Edit" onClick={onEdit}>
          <Pencil className="size-3" />
        </IconButton>
        <button
          type="button"
          disabled={busy}
          className="flex items-center gap-1 rounded border border-border px-2 py-1 text-[10px] text-foreground hover:bg-muted disabled:opacity-50"
          onClick={onRun}
        >
          <Play className="size-3" />
          Run now
        </button>
      </div>
    </div>
  );
}

function RoutineEditor({
  value,
  busy,
  onChange,
  onCancel,
  onSave,
}: {
  value: RoutineForm;
  busy: boolean;
  onChange: (value: RoutineForm) => void;
  onCancel: () => void;
  onSave: () => void;
}) {
  return (
    <div className="border-b border-border bg-muted/20 p-3">
      <div className="mb-2 flex items-center justify-between">
        <p className="font-medium text-foreground">{value.id ? "Edit routine" : "New routine"}</p>
        <IconButton label="Close" onClick={onCancel}>
          <X className="size-3.5" />
        </IconButton>
      </div>
      <div className="flex flex-col gap-2">
        <Field label="Name">
          <input
            className="w-full rounded border border-border bg-background px-2 py-1.5 text-foreground"
            value={value.name}
            onChange={(event) => onChange({ ...value, name: event.target.value })}
          />
        </Field>
        <Field label="Cron">
          <input
            className="w-full rounded border border-border bg-background px-2 py-1.5 font-mono text-foreground"
            value={value.cron}
            onChange={(event) => onChange({ ...value, cron: event.target.value })}
          />
        </Field>
        <Field label="Order">
          <textarea
            rows={6}
            className="w-full resize-y rounded border border-border bg-background px-2 py-1.5 text-foreground"
            value={value.orderText}
            onChange={(event) => onChange({ ...value, orderText: event.target.value })}
          />
        </Field>
        <Field label="Daily cap">
          <input
            type="number"
            min={1}
            className="w-full rounded border border-border bg-background px-2 py-1.5 text-foreground"
            value={value.dailyCap}
            onChange={(event) =>
              onChange({ ...value, dailyCap: Number(event.target.value) })
            }
          />
        </Field>
        <button
          type="button"
          disabled={
            busy ||
            !value.name.trim() ||
            !value.cron.trim() ||
            !value.orderText.trim() ||
            value.dailyCap < 1
          }
          className="flex items-center justify-center gap-1 rounded bg-foreground px-3 py-1.5 text-background disabled:opacity-40"
          onClick={onSave}
        >
          <Save className="size-3.5" />
          Save
        </button>
      </div>
    </div>
  );
}

function PipelineView({ routineId }: { routineId: number }) {
  const [payload, setPayload] = useState<PipelinePayload | null>(null);
  const [stage, setStage] = useState<"all" | Stage>("all");
  const [expanded, setExpanded] = useState<number | null>(null);
  const [error, setError] = useState("");
  const base = projectBase();

  const load = async () => {
    try {
      setPayload(await request(`/api/mailarr/routines/${routineId}/pipeline`));
      setError("");
    } catch (caught) {
      setError(message(caught));
    }
  };

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 30_000);

    return () => clearInterval(timer);
  }, [base, routineId]);

  const items = useMemo(
    () =>
      payload?.items.filter((item) => stage === "all" || item.stage === stage) ?? [],
    [payload, stage],
  );

  if (error) return <p className="p-4 text-xs text-red-600">{error}</p>;
  if (!payload) return <p className="p-4 text-xs text-muted-foreground">Loading pipeline...</p>;

  return (
    <div className="min-h-0 flex-1 overflow-auto p-3 text-xs">
      <div className="mb-3 flex items-start justify-between gap-2">
        <div>
          <p className="text-sm font-semibold text-foreground">{payload.routine.name}</p>
          <p className="font-mono text-[10px] text-muted-foreground">{payload.routine.cron}</p>
        </div>
        <IconButton label="Refresh" onClick={() => void load()}>
          <RefreshCw className="size-3.5" />
        </IconButton>
      </div>

      {payload.briefing && (
        <section className="mb-3 rounded-md border border-border bg-muted/20 p-3">
          <p className="mb-1 font-medium text-foreground">Latest briefing</p>
          <p className="mb-2 text-[10px] text-muted-foreground">
            {relativeTime(payload.briefing.createdAt)}
          </p>
          <div className="whitespace-pre-wrap text-[11px] leading-relaxed text-foreground/90">
            {payload.briefing.markdown}
          </div>
        </section>
      )}

      <div className="mb-3 flex gap-1 overflow-x-auto pb-1">
        {STAGES.map((entry) => (
          <button
            key={entry.key}
            type="button"
            className={cn(
              "shrink-0 rounded border px-2 py-1 text-[10px]",
              stage === entry.key
                ? "border-foreground bg-foreground text-background"
                : "border-border text-muted-foreground hover:text-foreground",
            )}
            onClick={() => setStage(entry.key)}
          >
            {entry.label} {payload.counts[entry.key] ?? 0}
          </button>
        ))}
      </div>

      <div className="min-w-[680px] overflow-hidden rounded-md border border-border">
        <div className="grid grid-cols-[24px_1.2fr_1.4fr_0.8fr_0.8fr_90px] gap-2 bg-muted/50 px-2 py-1.5 text-[10px] font-medium text-muted-foreground">
          <span />
          <span>Company</span>
          <span>Role</span>
          <span>Rate</span>
          <span>Stage</span>
          <span>Source / date</span>
        </div>
        {items.map((item) => (
          <div key={item.id} className="border-t border-border first:border-t-0">
            <button
              type="button"
              className="grid w-full grid-cols-[24px_1.2fr_1.4fr_0.8fr_0.8fr_90px] gap-2 px-2 py-2 text-left hover:bg-muted/30"
              onClick={() => setExpanded(expanded === item.id ? null : item.id)}
            >
              {expanded === item.id ? (
                <ChevronDown className="size-3.5 text-muted-foreground" />
              ) : (
                <ChevronRight className="size-3.5 text-muted-foreground" />
              )}
              <span className="truncate font-medium text-foreground">{item.company}</span>
              <span className="truncate text-foreground/90">{item.role}</span>
              <span className="truncate text-muted-foreground">{item.rateInfo || "Not listed"}</span>
              <span className="capitalize text-muted-foreground">{item.stage}</span>
              <span className="truncate text-[10px] text-muted-foreground">
                {item.source}
                <br />
                {new Date(item.createdAt).toLocaleDateString()}
              </span>
            </button>
            {expanded === item.id && <ItemDetail item={item} />}
          </div>
        ))}
        {!items.length && (
          <p className="border-t border-border p-4 text-center text-muted-foreground">
            No items in this stage.
          </p>
        )}
      </div>
    </div>
  );
}

function ItemDetail({ item }: { item: Item }) {
  return (
    <div className="grid gap-3 bg-muted/15 px-8 py-3 text-[11px] md:grid-cols-2">
      <Detail label="Score" value={String(item.score)} />
      <Detail label="Contact" value={item.contactEmail ?? "No apply-context email found"} />
      <Detail label="Fit notes" value={item.fitNotes ?? "None"} />
      <Detail label="Drop reason" value={item.dropReason ?? "None"} />
      <Detail label="Draft pitch" value={item.draftPitch ?? "None"} wide />
      <Detail label="Sent pitch" value={item.sentPitch ?? "None"} wide />
      <a
        className="text-blue-600 underline"
        href={item.url}
        target="_blank"
        rel="noreferrer"
      >
        Open source posting
      </a>
    </div>
  );
}

function Detail({ label, value, wide = false }: { label: string; value: string; wide?: boolean }) {
  return (
    <div className={cn(wide && "md:col-span-2")}>
      <p className="mb-1 font-medium text-muted-foreground">{label}</p>
      <p className="whitespace-pre-wrap text-foreground/90">{value}</p>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[10px] font-medium text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}

function IconButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      className="rounded p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function openPipelineEditor(worktreeId: number, routine: Routine): boolean {
  const shared = (
    globalThis as typeof globalThis & {
      __QUBE_SHARED__?: {
        editorTabs?: {
          open: (
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
  ).__QUBE_SHARED__;

  if (!shared?.editorTabs?.open) return false;

  shared.editorTabs.open(worktreeId, {
    ext: "mailarr",
    editor: "pipeline",
    key: `routine:${routine.id}`,
    title: routine.name,
    payload: { routineId: routine.id },
  });

  return true;
}

function editorRoutineId(payload: unknown): number | null {
  if (!payload || typeof payload !== "object" || !("routineId" in payload)) return null;

  const id = Number((payload as { routineId: unknown }).routineId);

  return Number.isInteger(id) && id > 0 ? id : null;
}

function relativeTime(value?: string | null): string {
  if (!value) return "never";

  const seconds = Math.round((new Date(value).getTime() - Date.now()) / 1000);
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ["year", 31_536_000],
    ["month", 2_592_000],
    ["day", 86_400],
    ["hour", 3_600],
    ["minute", 60],
  ];

  for (const [unit, size] of units) {
    if (Math.abs(seconds) >= size) return formatter.format(Math.round(seconds / size), unit);
  }

  return formatter.format(seconds, "second");
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const mailarr: WebExtension = {
  id: "mailarr",
  panels: [
    {
      id: "mailarr",
      icon: BriefcaseBusiness,
      title: "Mailarr",
      scope: "session",
      render: (worktreeId) => <MailarrPanel worktreeId={worktreeId} />,
    },
  ],
  editors: [
    {
      id: "pipeline",
      icon: BriefcaseBusiness,
      render: (_worktreeId, payload) => {
        const routineId = editorRoutineId(payload);

        return routineId ? (
          <PipelineView routineId={routineId} />
        ) : (
          <p className="p-4 text-xs text-red-600">Invalid Mailarr pipeline payload.</p>
        );
      },
    },
  ],
};

export default mailarr;
