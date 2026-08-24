import { test } from "node:test";
import assert from "node:assert/strict";

import {
  defaultTriggerSettings,
  evaluateTrigger,
  queryFromTrigger,
  type TriggerEvent,
  type TriggerSetting,
} from "../src/triggers.ts";

const AT = 1_700_000_000_000;

const wake: TriggerEvent = {
  kind: "wake_phrase",
  at: AT,
  phrase: "hey memory",
  query: "what did Dana say about the invoice",
};
const calendar: TriggerEvent = {
  kind: "calendar_context",
  at: AT,
  eventTitle: "Invoice review",
  participants: ["dana"],
};
const location: TriggerEvent = { kind: "location", at: AT, placeId: "office", label: "office" };

test("with shipped defaults nothing surfaces proactively and only an explicit ask recalls", () => {
  const settings = defaultTriggerSettings();

  // Every proactive path is off out of the box: this is the containment for
  // "unreliable continuous prediction" — the device never guesses.
  assert.deepEqual(
    settings.filter((s) => s.proactive),
    [],
  );

  const asked = evaluateTrigger(wake, settings);
  assert.equal(asked.surface, true);
  assert.equal(asked.mode, "reactive");
  assert.equal(asked.query, "what did Dana say about the invoice");

  for (const event of [calendar, location]) {
    const decision = evaluateTrigger(event, settings);
    assert.equal(decision.surface, false, `${event.kind} surfaced with default settings`);
    assert.equal(decision.mode, "proactive");
    assert.match(decision.reason, /opt-in and currently off/);
  }
});

test("proactivity is per trigger type, and a disabled or empty trigger is inert", () => {
  const optedIn: TriggerSetting[] = [
    { kind: "wake_phrase", enabled: true, proactive: false },
    { kind: "calendar_context", enabled: true, proactive: true },
    { kind: "location", enabled: true, proactive: false },
  ];

  assert.equal(evaluateTrigger(calendar, optedIn).surface, true);
  // Opting in to calendar context says nothing about location.
  assert.equal(evaluateTrigger(location, optedIn).surface, false);

  const off: TriggerSetting[] = [{ kind: "wake_phrase", enabled: false, proactive: false }];
  const disabled = evaluateTrigger(wake, off);
  assert.equal(disabled.surface, false);
  assert.match(disabled.reason, /disabled/);

  // A trigger type with no setting at all is inert, not permissive.
  assert.equal(evaluateTrigger(location, off).surface, false);

  // A wake phrase that carried no question is not an excuse to search.
  const empty = evaluateTrigger({ ...wake, query: "   " }, defaultTriggerSettings());
  assert.equal(empty.surface, false);
  assert.match(empty.reason, /carried no query/);

  assert.equal(queryFromTrigger(calendar), "Invoice review dana");
});
