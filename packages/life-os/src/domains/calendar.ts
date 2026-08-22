import type { ConnectorItem } from "../connectors.ts";
import { boolField, numField, strField } from "../connectors.ts";
import type { Commitment, DomainReport, Proposal, QuarantineNote } from "../types.ts";
import { flattenText } from "../untrusted.ts";
import type { DomainAgent, DomainContext } from "./types.ts";
import { HOUR, clock } from "./types.ts";

interface Event {
  id: string;
  title: string;
  startMs: number;
  endMs: number;
  needsResponse: boolean;
  needsPrep: boolean;
  guests: number;
}

const readEvents = (items: ConnectorItem[]): Event[] =>
  items
    .map((item) => ({
      id: item.id,
      // Titles are third-party text; flatten them before they reach a brief.
      title: flattenText(strField(item, "title", "(untitled)"), 60),
      startMs: numField(item, "startMs"),
      endMs: numField(item, "endMs"),
      needsResponse: boolField(item, "needsResponse"),
      needsPrep: boolField(item, "needsPrep"),
      guests: numField(item, "guests"),
    }))
    .filter((e) => e.endMs > e.startMs)
    .sort((a, b) => a.startMs - b.startMs);

const overlaps = (a: Event, b: Event): boolean =>
  a.startMs < b.endMs && b.startMs < a.endMs;

/**
 * Reads the calendar and nothing else.
 *
 * It resolves *within* its own domain — a double booking it can see in its own
 * data becomes a proposal to decline one of them. It never reasons about money
 * or health, because it cannot see either; anything that crosses a boundary
 * leaves here as a typed effect and is settled, or not settled, by the
 * coordinator.
 */
export class CalendarAgent implements DomainAgent {
  readonly domain = "calendar" as const;
  readonly connectorIds = ["calendar.primary"] as const;

  async propose(ctx: DomainContext): Promise<DomainReport> {
    const items = await ctx.connectors.read("calendar.primary", "events");
    const events = readEvents(items);

    const quarantined: QuarantineNote[] = items
      .filter((item) => item.trust === "quarantined")
      .map((item) => ({
        domain: this.domain,
        connectorId: "calendar.primary",
        itemId: item.id,
        patterns: item.flags,
      }));

    // Busy time is published so other domains' proposals can be checked against
    // it without anyone else reading the calendar.
    const commitments: Commitment[] = events.map((e) => ({
      domain: this.domain,
      id: `busy:${e.id}`,
      effect: { kind: "time", startMs: e.startMs, endMs: e.endMs, label: e.title },
    }));

    const proposals: Proposal[] = [];

    const upcoming = events.filter((e) => e.startMs >= ctx.nowMs);

    const needsPrep = upcoming.find((e) => e.needsPrep);
    if (needsPrep) {
      const start = needsPrep.startMs - HOUR;
      proposals.push({
        id: "calendar:prep-hold",
        domain: this.domain,
        actionKind: "calendar.hold_tentative",
        title: `Hold ${clock(start)}–${clock(needsPrep.startMs)} to prepare for "${needsPrep.title}"`,
        detail: `${needsPrep.title} starts at ${clock(needsPrep.startMs)} with ${needsPrep.guests} guests and is marked as needing prep.`,
        urgency: 2,
        confidence: 0.8,
        effects: [
          {
            kind: "time",
            startMs: start,
            endMs: needsPrep.startMs,
            label: `Prep for ${needsPrep.title}`,
          },
        ],
        sources: [needsPrep.id],
      });
    }

    const clash = findClash(upcoming);
    if (clash) {
      const [keep, drop] = clash;
      proposals.push({
        id: "calendar:decline-clash",
        domain: this.domain,
        actionKind: "calendar.decline_invite",
        title: `Decline "${drop.title}" — it double-books "${keep.title}"`,
        detail: `${clock(drop.startMs)}–${clock(drop.endMs)} overlaps ${clock(keep.startMs)}–${clock(keep.endMs)}. Declining notifies ${drop.guests} people.`,
        urgency: 2,
        confidence: 0.6,
        // Declining frees time rather than taking any, so no time effect.
        effects: [],
        sources: [drop.id, keep.id],
      });
    }

    const unanswered = upcoming.find((e) => e.needsResponse);
    if (unanswered) {
      proposals.push({
        id: "calendar:respond-reminder",
        domain: this.domain,
        actionKind: "calendar.create_reminder",
        title: `Remind me to RSVP to "${unanswered.title}"`,
        detail: `Still unanswered, and it starts at ${clock(unanswered.startMs)}.`,
        urgency: 1,
        confidence: 0.9,
        effects: [],
        sources: [unanswered.id],
      });
    }

    return {
      domain: this.domain,
      proposals,
      commitments,
      quarantined,
      note: proposals.length === 0 ? "Nothing on the calendar needs attention." : "",
    };
  }
}

/** The first overlapping pair, keeping the earlier one. */
function findClash(events: Event[]): [Event, Event] | null {
  for (let i = 0; i < events.length; i += 1) {
    for (let j = i + 1; j < events.length; j += 1) {
      const a = events[i];
      const b = events[j];
      if (a && b && overlaps(a, b)) return [a, b];
    }
  }
  return null;
}
