export const ITEM_STAGES = [
  "discovered",
  "qualified",
  "contacted",
  "replied",
  "dropped",
] as const;

export type ItemStage = (typeof ITEM_STAGES)[number];
export type RunStatus = "pending" | "running" | "done" | "failed";
export const SOURCE_STATUSES = ["candidate", "verified", "dead"] as const;
export type SourceStatus = (typeof SOURCE_STATUSES)[number];

export interface Routine {
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
  createdAt: string;
  updatedAt: string;
}

export interface RoutineSource {
  routineId: number;
  name: string;
  url: string;
  notes: string;
  status: SourceStatus;
  addedAt: string;
  updatedAt: string;
}

export interface Run {
  id: number;
  routineId: number;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  scheduledFor: string | null;
  status: RunStatus;
  errorText: string | null;
  foundCount: number;
  qualifiedCount: number;
  sentCount: number;
}

export interface Item {
  id: number;
  routineId: number;
  runId: number;
  stage: ItemStage;
  company: string;
  normalizedCompany: string;
  role: string;
  rateInfo: string;
  source: string;
  url: string;
  contactEmail: string | null;
  score: number;
  fitNotes: string | null;
  draftPitch: string | null;
  sentPitch: string | null;
  contactedDryRun: boolean;
  dropReason: string | null;
  payload: unknown;
  createdAt: string;
  updatedAt: string;
}
