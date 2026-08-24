import { test } from "node:test";
import assert from "node:assert/strict";

import {
  emptyPolicy,
  evaluateCapture,
  minuteOfUtcDay,
  type CapturePolicy,
} from "../src/policy.ts";

/** 2023-11-14T22:13:20Z — 22:13 UTC, i.e. minute 1333. */
const AT = 1_700_000_000_000;

const policy: CapturePolicy = {
  zones: [{ placeId: "home-bathroom", label: "bathroom" }],
  windows: [{ label: "overnight", startMinute: 1380, endMinute: 420 }],
  privateSessions: ["therapy-2024-03"],
};

test("excluded zones, private sessions and time windows block capture outright", () => {
  assert.equal(minuteOfUtcDay(AT), 1333);

  const base = { at: AT, placeId: "office", sessionId: "standup" };
  assert.equal(evaluateCapture(base, policy).allowed, true);
  assert.equal(evaluateCapture(base, emptyPolicy()).allowed, true);

  const inBathroom = evaluateCapture({ ...base, placeId: "home-bathroom" }, policy);
  assert.equal(inBathroom.allowed, false);
  assert.match(inBathroom.reason, /excluded zone: bathroom/);

  const inTherapy = evaluateCapture({ ...base, sessionId: "therapy-2024-03" }, policy);
  assert.equal(inTherapy.allowed, false);
  assert.match(inTherapy.reason, /marked private/);

  // A window that wraps past midnight is two ranges: 23:00 and 02:00 are both
  // inside "overnight", 12:00 is not.
  const atMinute = (minute: number) => Math.floor(AT / 86_400_000) * 86_400_000 + minute * 60_000;
  assert.equal(evaluateCapture({ ...base, at: atMinute(1_400) }, policy).allowed, false);
  assert.equal(evaluateCapture({ ...base, at: atMinute(120) }, policy).allowed, false);
  assert.equal(evaluateCapture({ ...base, at: atMinute(720) }, policy).allowed, true);
  assert.match(evaluateCapture({ ...base, at: atMinute(120) }, policy).reason, /overnight/);
});
