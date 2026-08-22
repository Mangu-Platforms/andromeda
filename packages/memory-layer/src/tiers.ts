/**
 * The three-tier compute split, enforced.
 *
 * The dominant blocker for a memory wearable is that the device cannot do the
 * work: continuous transcription and embedding do not fit inside a badge-sized
 * thermal and power envelope. The containment is to stop pretending it can —
 * the device captures, the phone/edge does the expensive derivation, and the
 * cloud only ever holds derived metadata.
 *
 * That split is only worth something if it is checked rather than intended, so
 * a pipeline here is a list of stages that each declare their cost and the data
 * class they consume and emit, and `planTiers` decides where each one runs. A
 * stage that will not fit on the device is moved outward; a stage that cannot
 * fit anywhere, or that would carry raw audio across a boundary that may not
 * hold it, fails the plan instead of running degraded.
 */

export type Tier = "device" | "edge" | "cloud";

/** Ordered outward. Data flows forward through this list and never back. */
export const TIER_ORDER: Tier[] = ["device", "edge", "cloud"];

/**
 * What a piece of data *is*, which is what decides where it may live.
 * `raw_audio` is other people's voices; `transcript` is their words; only
 * `embedding` and `metadata` are derived far enough to leave the user's own
 * hardware.
 */
export type DataClass = "raw_audio" | "transcript" | "embedding" | "metadata";

export interface TierCapacity {
  tier: Tier;
  /** Compute units this tier can sustain per second of captured audio. */
  computeUnits: number;
  /** Sustained power envelope in milliwatts. The thermal half of the blocker. */
  powerMw: number;
  /** Data classes this tier is permitted to hold. */
  holds: DataClass[];
}

export interface ProcessingStage {
  id: string;
  /** Compute units consumed per second of captured audio. */
  computeUnits: number;
  powerMw: number;
  consumes: DataClass;
  emits: DataClass;
  /**
   * Force this stage onto a specific tier. A pin that does not fit is an error
   * rather than a hint — otherwise a plan could silently relocate the one stage
   * whose placement was the point.
   */
  pin?: Tier;
}

export interface StagePlacement {
  stageId: string;
  tier: Tier;
  /** Why this tier and not an earlier one. Read by reviewers and tests. */
  reason: string;
}

export interface TierLoad {
  computeUnits: number;
  powerMw: number;
}

export interface TierPlan {
  placements: StagePlacement[];
  load: Record<Tier, TierLoad>;
}

export class TierBudgetError extends Error {
  readonly stageId: string;
  readonly reasons: string[];

  constructor(stageId: string, reasons: string[]) {
    super(`stage "${stageId}" cannot be placed:\n  - ${reasons.join("\n  - ")}`);
    this.name = "TierBudgetError";
    this.stageId = stageId;
    this.reasons = reasons;
  }
}

/** Thrown when something that is not derived metadata is about to leave the edge. */
export class CloudBoundaryError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(`refused to cross the cloud boundary:\n  - ${issues.join("\n  - ")}`);
    this.name = "CloudBoundaryError";
    this.issues = issues;
  }
}

/**
 * A badge-class wearable, a phone, and a server.
 *
 * The device numbers are the blocker made numeric: ~1 compute unit and 30 mW is
 * enough for capture and voice-activity gating and nothing else, which is why
 * transcription is never placed there.
 */
export const DEFAULT_TIERS: TierCapacity[] = [
  { tier: "device", computeUnits: 1, powerMw: 30, holds: ["raw_audio"] },
  {
    tier: "edge",
    computeUnits: 400,
    powerMw: 3_500,
    holds: ["raw_audio", "transcript", "embedding", "metadata"],
  },
  { tier: "cloud", computeUnits: 100_000, powerMw: 250_000, holds: ["embedding", "metadata"] },
];

/** The default capture-to-index pipeline. Costs are per second of audio. */
export const DEFAULT_STAGES: ProcessingStage[] = [
  {
    id: "capture",
    computeUnits: 0.35,
    powerMw: 18,
    consumes: "raw_audio",
    emits: "raw_audio",
    pin: "device",
  },
  {
    id: "voice-activity",
    computeUnits: 0.5,
    powerMw: 9,
    consumes: "raw_audio",
    emits: "raw_audio",
  },
  // Far outside the device envelope on purpose: this is the stage the blocker
  // is about, and the plan is what forces it onto the phone.
  { id: "transcribe", computeUnits: 120, powerMw: 900, consumes: "raw_audio", emits: "transcript" },
  { id: "embed", computeUnits: 12, powerMw: 80, consumes: "transcript", emits: "embedding" },
  { id: "extract", computeUnits: 45, powerMw: 320, consumes: "transcript", emits: "metadata" },
  { id: "index-local", computeUnits: 3, powerMw: 25, consumes: "embedding", emits: "metadata" },
  {
    id: "index-cloud",
    computeUnits: 40,
    powerMw: 400,
    consumes: "embedding",
    emits: "metadata",
    pin: "cloud",
  },
];

const emptyLoad = (): Record<Tier, TierLoad> => ({
  device: { computeUnits: 0, powerMw: 0 },
  edge: { computeUnits: 0, powerMw: 0 },
  cloud: { computeUnits: 0, powerMw: 0 },
});

function fitIssues(
  stage: ProcessingStage,
  capacity: TierCapacity,
  load: TierLoad,
): string[] {
  const issues: string[] = [];
  if (!capacity.holds.includes(stage.consumes)) {
    issues.push(`${capacity.tier} may not hold ${stage.consumes} (its input)`);
  }
  if (!capacity.holds.includes(stage.emits)) {
    issues.push(`${capacity.tier} may not hold ${stage.emits} (its output)`);
  }
  const compute = load.computeUnits + stage.computeUnits;
  if (compute > capacity.computeUnits) {
    issues.push(
      `${capacity.tier} compute budget exceeded: ${compute.toFixed(2)} of ${capacity.computeUnits} units`,
    );
  }
  const power = load.powerMw + stage.powerMw;
  if (power > capacity.powerMw) {
    issues.push(
      `${capacity.tier} power budget exceeded: ${power.toFixed(0)} of ${capacity.powerMw} mW`,
    );
  }
  return issues;
}

/**
 * Place every stage on the innermost tier that can hold its data and afford its
 * cost, given everything already placed there.
 *
 * Budgets are cumulative per tier, because the device does not get a fresh
 * thermal envelope for each stage. Placement is monotonic outward: once work
 * has moved to the phone, a later stage cannot be pushed back onto the device,
 * which is both physically true and what keeps `holds` meaningful.
 *
 * Throws `TierBudgetError` rather than degrading. A plan that cannot be met is
 * a product that does not work, and it should say so at planning time.
 */
export function planTiers(
  stages: ProcessingStage[] = DEFAULT_STAGES,
  tiers: TierCapacity[] = DEFAULT_TIERS,
): TierPlan {
  const byTier = new Map(tiers.map((t) => [t.tier, t]));
  const load = emptyLoad();
  const placements: StagePlacement[] = [];
  let minIndex = 0;

  for (const stage of stages) {
    if (stage.pin) {
      const capacity = byTier.get(stage.pin);
      if (!capacity) throw new TierBudgetError(stage.id, [`unknown tier "${stage.pin}"`]);
      const pinIndex = TIER_ORDER.indexOf(stage.pin);
      const issues = fitIssues(stage, capacity, load[stage.pin]);
      if (pinIndex < minIndex) {
        issues.push(
          `pinned to ${stage.pin}, but earlier stages already moved to ${TIER_ORDER[minIndex]}; data does not flow back inward`,
        );
      }
      if (issues.length > 0) throw new TierBudgetError(stage.id, issues);
      load[stage.pin] = {
        computeUnits: load[stage.pin].computeUnits + stage.computeUnits,
        powerMw: load[stage.pin].powerMw + stage.powerMw,
      };
      placements.push({ stageId: stage.id, tier: stage.pin, reason: `pinned to ${stage.pin}` });
      minIndex = pinIndex;
      continue;
    }

    const rejected: string[] = [];
    let placed = false;
    for (let i = minIndex; i < TIER_ORDER.length; i++) {
      const tier = TIER_ORDER[i];
      if (!tier) continue;
      const capacity = byTier.get(tier);
      if (!capacity) continue;
      const issues = fitIssues(stage, capacity, load[tier]);
      if (issues.length > 0) {
        rejected.push(...issues);
        continue;
      }
      load[tier] = {
        computeUnits: load[tier].computeUnits + stage.computeUnits,
        powerMw: load[tier].powerMw + stage.powerMw,
      };
      placements.push({
        stageId: stage.id,
        tier,
        reason:
          rejected.length === 0
            ? `fits the ${tier} budget`
            : `offloaded to ${tier}: ${rejected[0]}`,
      });
      minIndex = i;
      placed = true;
      break;
    }
    if (!placed) throw new TierBudgetError(stage.id, rejected);
  }

  return { placements, load };
}

export function tierOf(plan: TierPlan, stageId: string): Tier | null {
  return plan.placements.find((p) => p.stageId === stageId)?.tier ?? null;
}

/* --------------------------------------------------------------------------
 * The cloud boundary
 * ----------------------------------------------------------------------- */

/** Keys that only ever appear on media or verbatim speech. */
const FORBIDDEN_KEYS = new Set([
  "text",
  "transcript",
  "media",
  "sampleRef",
  "audio",
  "audioBase64",
  "pcm",
  "waveform",
  "speakerId",
]);

/** Keys a record leaving the edge is allowed to have. Anything else is refused. */
const CLOUD_RECORD_KEYS = new Set([
  "entryId",
  "sessionId",
  "speakerRef",
  "at",
  "retentionUntil",
  "topics",
  "vector",
]);

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Deep scan for anything that is not derived metadata.
 *
 * Every media and transcript object in this package carries a `dataClass` tag,
 * so the scan can recognise them structurally wherever they are nested — a
 * transcript smuggled inside a `topics` array is still a transcript.
 */
export function cloudPayloadIssues(value: unknown, path = "$"): string[] {
  const issues: string[] = [];

  if (Array.isArray(value)) {
    value.forEach((item, i) => issues.push(...cloudPayloadIssues(item, `${path}[${i}]`)));
    return issues;
  }
  if (!isPlainObject(value)) return issues;

  const dataClass = value["dataClass"];
  if (typeof dataClass === "string" && dataClass !== "embedding" && dataClass !== "metadata") {
    issues.push(`${path} carries dataClass "${dataClass}", which may not leave the edge tier`);
  }
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.has(key)) {
      issues.push(`${path}.${key} is raw or identifying content and may not leave the edge tier`);
    }
    issues.push(...cloudPayloadIssues(child, `${path}.${key}`));
  }
  return issues;
}

/** Strict shape check for a single record. Rejects unknown keys rather than dropping them. */
export function cloudRecordIssues(value: unknown, path = "$"): string[] {
  if (!isPlainObject(value)) return [`${path} is not a record`];
  const issues: string[] = [];
  for (const key of Object.keys(value)) {
    if (!CLOUD_RECORD_KEYS.has(key)) issues.push(`${path}.${key} is not a permitted cloud field`);
  }
  for (const key of CLOUD_RECORD_KEYS) {
    if (!Object.hasOwn(value, key)) issues.push(`${path}.${key} is missing`);
  }
  const vector = value["vector"];
  if (!Array.isArray(vector) || vector.some((n) => typeof n !== "number")) {
    issues.push(`${path}.vector must be an array of numbers`);
  }
  const topics = value["topics"];
  if (!Array.isArray(topics) || topics.some((t) => typeof t !== "string")) {
    issues.push(`${path}.topics must be an array of strings`);
  }
  return issues;
}

/**
 * The single choke point for anything moving to the cloud tier. Enforced at the
 * receiving end as well as the sending end, so a new call site cannot forget it.
 */
export function assertCloudPayload(records: unknown): asserts records is unknown[] {
  if (!Array.isArray(records)) throw new CloudBoundaryError(["payload is not an array of records"]);
  const issues = [
    ...cloudPayloadIssues(records),
    ...records.flatMap((r, i) => cloudRecordIssues(r, `$[${i}]`)),
  ];
  if (issues.length > 0) throw new CloudBoundaryError(issues);
}
