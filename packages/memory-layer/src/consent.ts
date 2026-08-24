/**
 * Per-speaker consent.
 *
 * This product records people who did not buy it. Consent therefore cannot be a
 * paragraph in an onboarding flow — it has to be the thing that decides whether
 * a sentence is ever written down, and it has to keep deciding afterwards, so
 * that revoking it removes reach rather than just stopping new collection.
 *
 * The registry is deliberately mutable only through these methods. Nothing
 * derived from a model, a transcript, or a remote payload can reach it, which
 * is what stops an utterance from talking its way into being retained.
 */

export type ConsentState = "granted" | "revoked" | "unknown";

export interface SpeakerConsent {
  speakerId: string;
  state: ConsentState;
  /** How long an utterance from this speaker may be retained, in days. */
  retentionDays: number;
  /** When the current state was recorded. */
  recordedAt: number;
}

/** Conservative default: two weeks, and only for speakers who said yes. */
export const DEFAULT_RETENTION_DAYS = 14;

export const DAY_MS = 86_400_000;

export class ConsentError extends Error {
  readonly speakerId: string;

  constructor(speakerId: string, state: ConsentState) {
    super(`speaker "${speakerId}" has not granted consent (state: ${state})`);
    this.name = "ConsentError";
    this.speakerId = speakerId;
  }
}

export class ConsentRegistry {
  readonly #byId = new Map<string, SpeakerConsent>();

  constructor(entries: SpeakerConsent[] = []) {
    for (const entry of entries) this.#byId.set(entry.speakerId, { ...entry });
  }

  grant(speakerId: string, at: number, retentionDays = DEFAULT_RETENTION_DAYS): SpeakerConsent {
    if (!(retentionDays > 0)) throw new Error("retentionDays must be positive");
    const record: SpeakerConsent = {
      speakerId,
      state: "granted",
      retentionDays,
      recordedAt: at,
    };
    this.#byId.set(speakerId, record);
    return { ...record };
  }

  /**
   * Revocation keeps the record rather than deleting it: "this person said no"
   * is itself the fact that has to survive, or the next session would treat
   * them as merely unknown and ask again.
   */
  revoke(speakerId: string, at: number): SpeakerConsent {
    const existing = this.#byId.get(speakerId);
    const record: SpeakerConsent = {
      speakerId,
      state: "revoked",
      retentionDays: existing?.retentionDays ?? DEFAULT_RETENTION_DAYS,
      recordedAt: at,
    };
    this.#byId.set(speakerId, record);
    return { ...record };
  }

  /** An unheard-of speaker is `unknown`, which is not consent. */
  stateFor(speakerId: string): ConsentState {
    return this.#byId.get(speakerId)?.state ?? "unknown";
  }

  isGranted(speakerId: string): boolean {
    return this.stateFor(speakerId) === "granted";
  }

  retentionDaysFor(speakerId: string): number {
    return this.#byId.get(speakerId)?.retentionDays ?? DEFAULT_RETENTION_DAYS;
  }

  assertGranted(speakerId: string): void {
    const state = this.stateFor(speakerId);
    if (state !== "granted") throw new ConsentError(speakerId, state);
  }

  /** Ordered copy, for the audit log and the reviewer's view. */
  snapshot(): SpeakerConsent[] {
    return [...this.#byId.values()]
      .map((r) => ({ ...r }))
      .sort((a, b) => (a.speakerId < b.speakerId ? -1 : a.speakerId > b.speakerId ? 1 : 0));
  }
}
