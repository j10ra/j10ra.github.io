import assert from "node:assert/strict";
import test from "node:test";
import { cronMatches, localMinuteKey } from "../lib/cron.js";

test("cronMatches evaluates five-field local schedules", () => {
  const date = new Date(2026, 6, 29, 9, 0, 0);

  assert.equal(cronMatches("0 9 * * *", date), true);
  assert.equal(cronMatches("*/15 8-10 * * 1-5", date), true);
  assert.equal(cronMatches("1 9 * * *", date), false);
  assert.equal(localMinuteKey(date), "2026-07-29T09:00");
});
