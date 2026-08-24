/**
 * Places and times where the microphone does not run.
 *
 * This is the one control that has to act before anything else: a bathroom or a
 * meeting marked private must never produce audio at all, because "captured but
 * discarded later" is not what anyone means when they say a room is off limits.
 * `evaluateCapture` therefore runs on the device tier, ahead of transcription,
 * and its refusal is what stops the sample from being read.
 *
 * Time windows are expressed in minutes from UTC midnight so a policy is a
 * plain value with no timezone database behind it. A real deployment would
 * carry an IANA zone; that is noted as a limitation rather than faked here.
 */

export interface ExcludedZone {
  placeId: string;
  label: string;
}

export interface ExcludedWindow {
  label: string;
  /** Minutes from UTC midnight, inclusive. */
  startMinute: number;
  /** Minutes from UTC midnight, exclusive. Wraps when less than `startMinute`. */
  endMinute: number;
}

export interface CapturePolicy {
  zones: ExcludedZone[];
  windows: ExcludedWindow[];
  /** Sessions a participant marked private, e.g. a meeting flagged in a calendar. */
  privateSessions: string[];
}

export interface CaptureContext {
  at: number;
  placeId: string;
  sessionId: string;
}

export interface CaptureDecision {
  allowed: boolean;
  reason: string;
}

export const emptyPolicy = (): CapturePolicy => ({
  zones: [],
  windows: [],
  privateSessions: [],
});

const MINUTES_PER_DAY = 1440;

export function minuteOfUtcDay(at: number): number {
  return Math.floor(((at % 86_400_000) + 86_400_000) % 86_400_000 / 60_000);
}

function windowContains(window: ExcludedWindow, minute: number): boolean {
  const start = ((window.startMinute % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  const end = ((window.endMinute % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  // A window that wraps past midnight is two ranges, not an empty one.
  return start <= end ? minute >= start && minute < end : minute >= start || minute < end;
}

export function evaluateCapture(ctx: CaptureContext, policy: CapturePolicy): CaptureDecision {
  const zone = policy.zones.find((z) => z.placeId === ctx.placeId);
  if (zone) {
    return { allowed: false, reason: `excluded zone: ${zone.label} (${zone.placeId})` };
  }
  if (policy.privateSessions.includes(ctx.sessionId)) {
    return { allowed: false, reason: `session ${ctx.sessionId} is marked private` };
  }
  const minute = minuteOfUtcDay(ctx.at);
  const window = policy.windows.find((w) => windowContains(w, minute));
  if (window) {
    return { allowed: false, reason: `excluded time window: ${window.label}` };
  }
  return { allowed: true, reason: "no exclusion applies" };
}
