import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parseArbeitnow } from "../lib/sources/arbeitnow.js";
import { parseHnHiring } from "../lib/sources/hn.js";
import { parseJobicy } from "../lib/sources/jobicy.js";
import { parseRemoteOk } from "../lib/sources/remoteok.js";
import { parseRemotive } from "../lib/sources/remotive.js";
import { parseWeWorkRemotely } from "../lib/sources/weworkremotely.js";

test("RemoteOK parser normalizes its captured payload", () => {
  const [posting] = parseRemoteOk(jsonFixture("remoteok.json"));

  assert.equal(posting.company, "Jizr");
  assert.equal(posting.role, "The GREEN Program");
  assert.equal(posting.source, "RemoteOK");
});

test("Remotive parser normalizes its captured payload", () => {
  const [posting] = parseRemotive(jsonFixture("remotive.json"));

  assert.equal(posting.company, "Workada");
  assert.equal(posting.rateInfo, "$18 - $22/hr");
  assert.match(posting.description, /Compensation/);
});

test("WeWorkRemotely parser normalizes its captured RSS payload", () => {
  const [posting] = parseWeWorkRemotely(textFixture("weworkremotely.xml"));

  assert.equal(posting.company, "Tether");
  assert.equal(posting.role, "AI Research Engineer");
  assert.equal(
    posting.url,
    "https://weworkremotely.com/remote-jobs/tether-ai-research-engineer",
  );
});

test("Arbeitnow parser normalizes its captured payload", () => {
  const [posting] = parseArbeitnow(jsonFixture("arbeitnow.json"));

  assert.equal(posting.company, "Affonso");
  assert.match(posting.description, /TypeScript/);
  assert.equal(posting.source, "Arbeitnow");
});

test("Jobicy parser normalizes its captured payload", () => {
  const [posting] = parseJobicy(jsonFixture("jobicy.json"));

  assert.equal(posting.company, "QAD, Inc.");
  assert.equal(posting.role, "Software Engineer, AI Agent Platform");
  assert.match(posting.description, /MCP tool server/);
});

test("HN parser normalizes top-level hiring comments from its captured payload", () => {
  const [posting] = parseHnHiring(jsonFixture("hn.json"));

  assert.equal(posting.company, "Goody");
  assert.match(posting.role, /Remote/);
  assert.match(posting.description, /mark@ongoody\.com/);
  assert.equal(posting.rateInfo, "$250K – $300K");
});

function jsonFixture(name: string): unknown {
  return JSON.parse(textFixture(name));
}

function textFixture(name: string): string {
  return readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
}
