export const BUILT_IN_SOURCES = [
  { id: "remoteok", label: "RemoteOK" },
  { id: "remotive", label: "Remotive" },
  { id: "weworkremotely", label: "WeWorkRemotely" },
  { id: "arbeitnow", label: "Arbeitnow" },
  { id: "jobicy", label: "Jobicy" },
  { id: "hn", label: "HN Who is hiring" },
] as const;

export type BuiltInSourceId = (typeof BUILT_IN_SOURCES)[number]["id"];
