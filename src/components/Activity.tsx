import { useEffect, useMemo, useState } from "react";
import { profile } from "../data/resume";

type Day = {
  date: string;
  count: number;
  level: 0 | 1 | 2 | 3 | 4;
};

type ContribData = {
  total: { lastYear: number };
  contributions: Day[];
};

// Built at deploy-time by scripts/fetch-github-data.mjs (incl. private contributions)
const BAKED_URL = `${import.meta.env.BASE_URL}contributions.json`;
// Fallback for local dev — third-party scraper, public contributions only
const FALLBACK_URL = `https://github-contributions-api.jogruber.de/v4/${profile.github}?y=last`;
const PROFILE_URL = `https://github.com/${profile.github}`;

function ActivityFallback({ message }: { message: string }) {
  return (
    <div className="activity activity--fallback">
      <p className="muted">{message}</p>
      <a className="btn" href={PROFILE_URL} target="_blank" rel="noreferrer">
        View on GitHub <span className="arrow">↗</span>
      </a>
    </div>
  );
}

export function Activity() {
  const [data, setData] = useState<ContribData | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">(
    "loading"
  );

  useEffect(() => {
    let cancelled = false;

    const tryFetch = async (url: string): Promise<ContribData | null> => {
      try {
        const r = await fetch(url);
        if (!r.ok) return null;
        const d = (await r.json()) as ContribData;
        if (!d.contributions || !Array.isArray(d.contributions)) return null;
        return d;
      } catch {
        return null;
      }
    };

    (async () => {
      // Prefer baked JSON (real data with private contributions)
      let d = await tryFetch(BAKED_URL);
      // Fall back to third-party scraper for local dev (public only)
      if (!d) d = await tryFetch(FALLBACK_URL);

      if (cancelled) return;
      if (d) {
        setData(d);
        setStatus("ready");
      } else {
        setStatus("error");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  // Chunk contributions into weeks (Sunday-aligned)
  const weeks = useMemo(() => {
    if (!data) return [];
    const days = data.contributions;
    if (days.length === 0) return [];
    const firstDow = new Date(days[0].date + "T00:00:00").getUTCDay();
    const padded: Array<Day | null> = Array(firstDow).fill(null);
    padded.push(...days);
    const out: Array<Array<Day | null>> = [];
    for (let i = 0; i < padded.length; i += 7) {
      out.push(padded.slice(i, i + 7));
    }
    return out;
  }, [data]);

  const totalRepos = useMemo(() => {
    if (!data) return null;
    const active = data.contributions.filter((d) => d.count > 0).length;
    return active;
  }, [data]);

  if (status === "loading") {
    return <ActivityFallback message="Loading recent activity…" />;
  }
  if (status === "error" || !data) {
    return <ActivityFallback message="Activity feed unavailable right now." />;
  }

  return (
    <div className="activity">
      <header className="activity-meta">
        <div>
          <p className="activity-stat">
            <span className="num">
              {data.total.lastYear.toLocaleString()}
            </span>
            <span className="lbl">contributions in the last year</span>
          </p>
          <p className="muted activity-sub">
            {totalRepos} active days · GitHub{" "}
            <a href={PROFILE_URL} target="_blank" rel="noreferrer">
              @{profile.github}
            </a>
          </p>
        </div>
        <a className="btn" href={PROFILE_URL} target="_blank" rel="noreferrer">
          View profile <span className="arrow">↗</span>
        </a>
      </header>

      <div className="heatmap" role="img" aria-label="Contribution heatmap">
        {weeks.map((week, wi) => (
          <div key={wi} className="heatmap-week">
            {Array.from({ length: 7 }).map((_, di) => {
              const day = week[di];
              if (!day) {
                return (
                  <span
                    key={di}
                    className="heatmap-cell heatmap-cell--empty"
                  />
                );
              }
              return (
                <span
                  key={di}
                  className={`heatmap-cell level-${day.level}`}
                  title={`${day.count} contribution${day.count === 1 ? "" : "s"} · ${day.date}`}
                />
              );
            })}
          </div>
        ))}
      </div>

      <footer className="activity-legend">
        <span className="muted">Less</span>
        <span className="heatmap-cell level-0" />
        <span className="heatmap-cell level-1" />
        <span className="heatmap-cell level-2" />
        <span className="heatmap-cell level-3" />
        <span className="heatmap-cell level-4" />
        <span className="muted">More</span>
      </footer>
    </div>
  );
}
