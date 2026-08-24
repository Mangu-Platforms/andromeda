/**
 * Recall happens on an explicit trigger, never on a prediction.
 *
 * The seductive version of this product watches everything and decides on its
 * own when you would like to be reminded of something. That requires reliable
 * continuous intent prediction, which does not exist; what it produces in
 * practice is a device that interrupts people at random and is therefore turned
 * off. The containment is to delete the prediction problem: recall is reachable
 * only from one of three named events, each of which is a piece of data a test
 * can construct, and anything the user did not explicitly ask for is opt-in per
 * trigger type and off by default.
 */

export type TriggerKind = "wake_phrase" | "calendar_context" | "location";

export type TriggerEvent =
  | { kind: "wake_phrase"; at: number; phrase: string; query: string }
  | { kind: "calendar_context"; at: number; eventTitle: string; participants: string[] }
  | { kind: "location"; at: number; placeId: string; label: string };

export interface TriggerSetting {
  kind: TriggerKind;
  /** Master switch. Off means the trigger is inert regardless of anything else. */
  enabled: boolean;
  /**
   * Whether this trigger may surface memories the user did not ask for.
   * Defaults to false everywhere; nothing in this package flips it.
   */
  proactive: boolean;
}

export interface TriggerDecision {
  surface: boolean;
  /** `reactive` means the user asked. `proactive` means the device volunteered. */
  mode: "reactive" | "proactive";
  query: string;
  reason: string;
}

/** A wake phrase is a request; the other two are the device volunteering. */
const MODE: Record<TriggerKind, "reactive" | "proactive"> = {
  wake_phrase: "reactive",
  calendar_context: "proactive",
  location: "proactive",
};

/**
 * The shipped defaults. Every trigger type is wired up and every proactive path
 * is off, so a freshly installed memory layer answers questions and volunteers
 * nothing.
 */
export function defaultTriggerSettings(): TriggerSetting[] {
  return [
    { kind: "wake_phrase", enabled: true, proactive: false },
    { kind: "calendar_context", enabled: true, proactive: false },
    { kind: "location", enabled: true, proactive: false },
  ];
}

export function queryFromTrigger(event: TriggerEvent): string {
  switch (event.kind) {
    case "wake_phrase":
      return event.query.trim();
    case "calendar_context":
      return [event.eventTitle, ...event.participants].join(" ").trim();
    case "location":
      return event.label.trim();
  }
}

/**
 * The only door into recall. A caller cannot skip it: the pipeline takes a
 * `TriggerEvent`, not a query string, so there is no path from "the microphone
 * is on" to "the index was searched" that does not pass through here.
 */
export function evaluateTrigger(
  event: TriggerEvent,
  settings: TriggerSetting[],
): TriggerDecision {
  const mode = MODE[event.kind];
  const query = queryFromTrigger(event);
  const setting = settings.find((s) => s.kind === event.kind);

  if (!setting || !setting.enabled) {
    return { surface: false, mode, query, reason: `trigger "${event.kind}" is disabled` };
  }
  if (mode === "proactive" && !setting.proactive) {
    return {
      surface: false,
      mode,
      query,
      reason: `proactive surfacing for "${event.kind}" is opt-in and currently off`,
    };
  }
  if (query.length === 0) {
    return { surface: false, mode, query, reason: `trigger "${event.kind}" carried no query` };
  }
  return {
    surface: true,
    mode,
    query,
    reason:
      mode === "reactive"
        ? `user asked via wake phrase "${event.kind === "wake_phrase" ? event.phrase : ""}"`
        : `proactive surfacing is enabled for "${event.kind}"`,
  };
}
