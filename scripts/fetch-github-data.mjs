#!/usr/bin/env node
/**
 * Fetches the user's GitHub contribution calendar (incl. private contributions
 * if the PAT belongs to that user) and writes it to public/contributions.json
 * for the static site to consume at runtime.
 *
 * Required env: GH_PAT (token with read:user scope)
 * Optional env: GH_USERNAME (defaults to j10ra)
 */
import { writeFile, mkdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const TOKEN = process.env.GH_PAT;
const USERNAME = process.env.GH_USERNAME || "j10ra";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_PATH = resolve(__dirname, "..", "public", "contributions.json");

if (!TOKEN) {
  console.error("[fetch-github-data] GH_PAT env var is required");
  process.exit(1);
}

const QUERY = /* GraphQL */ `
  query ($login: String!) {
    user(login: $login) {
      contributionsCollection {
        contributionCalendar {
          totalContributions
          weeks {
            contributionDays {
              date
              contributionCount
              contributionLevel
            }
          }
        }
      }
    }
  }
`;

const LEVEL_MAP = {
  NONE: 0,
  FIRST_QUARTILE: 1,
  SECOND_QUARTILE: 2,
  THIRD_QUARTILE: 3,
  FOURTH_QUARTILE: 4,
};

const res = await fetch("https://api.github.com/graphql", {
  method: "POST",
  headers: {
    Authorization: `bearer ${TOKEN}`,
    "Content-Type": "application/json",
    "User-Agent": "j10ra-cv-build",
  },
  body: JSON.stringify({ query: QUERY, variables: { login: USERNAME } }),
});

if (!res.ok) {
  throw new Error(`GitHub API ${res.status}: ${await res.text()}`);
}

const json = await res.json();
if (json.errors) {
  throw new Error(`GraphQL errors: ${JSON.stringify(json.errors)}`);
}

const cal = json.data.user.contributionsCollection.contributionCalendar;

const contributions = cal.weeks.flatMap((w) =>
  w.contributionDays.map((d) => ({
    date: d.date,
    count: d.contributionCount,
    level: LEVEL_MAP[d.contributionLevel] ?? 0,
  }))
);

const out = {
  total: { lastYear: cal.totalContributions },
  contributions,
  fetchedAt: new Date().toISOString(),
};

await mkdir(dirname(OUT_PATH), { recursive: true });
await writeFile(OUT_PATH, JSON.stringify(out));

console.log(
  `[fetch-github-data] ✓ ${out.contributions.length} days · ${out.total.lastYear} total contributions`
);
