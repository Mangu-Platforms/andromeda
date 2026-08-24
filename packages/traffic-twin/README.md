# AI-Driven Urban Traffic Optimizer

A digital-twin study tool for signal retiming. It recommends timings and
quantifies the benefit in simulation. It does not control anything.

## The blocker, and why the answer is to stay in simulation

Nobody can offer a formal zero-failure safety guarantee for live signal
control, and a vendor implying otherwise is selling liability they cannot
carry. Adaptive-control hardware costs roughly $30k–115k per intersection, so
the honest and commercially useful product is the one that comes *before* that
spend: prove the benefit in a twin, let a licensed engineer decide, and let the
agency deploy through its own controller processes.

So the containment is not a safety argument about the optimiser. It is that
there is nothing to actuate:

- The deliverable is a `SignalTimingRecommendation` — timings, numbers and
  caveats. It has no handle to a device and no method that could acquire one.
- `assertExportable` is the single place a study becomes releasable, and it
  requires `advisory: true`, a named approving engineer, and a passing safety
  report.
- A test greps the advisory path for `fetch`, `node:net`, `node:http`,
  `node:dgram`, `ntcip`, `actuate`, `sendToController`, `writeTiming`. If
  someone later adds a controller client, that test is what fails.

## Safety is applied before evaluation, not after

This ordering is the point. A candidate plan is validated against the
pre-committed envelope *first*; only survivors are simulated. An unsafe plan
therefore never receives a delay figure, so it can never be argued for on the
strength of one — the optimiser cannot trade a clearance interval for travel
time, because it never learns what the trade would be worth.

The envelope (`safety/policy.ts`) is plain data so an agency can review and diff
it. It bounds minimum green, pedestrian WALK plus clearance, yellow change and
all-red, cycle length, and maximum red (starvation). Defaults are conservative
readings of ITE/MUTCD practice — starting points for an agency to override, not
a standard this package certifies to.

Two details worth knowing:

- **Walk speed is capped, not believed.** `assumedWalkSpeedMps` is a property of
  the *plan's assumption*. Clearance is computed at the slower of assumed and
  the policy cap, so a plan that buys green time by assuming athletic
  pedestrians is refused. A 14 m crossing at a sprinting 3.5 m/s would "justify"
  11 s; the cap requires 18.67 s.
- **The conflict matrix is derived from geometry, not hand-listed.** Movements
  are chords across a ring of eight points (two per leg) and conflict exactly
  when their endpoints interleave. A hand-listed matrix is the artefact that
  silently rots when someone edits a plan.

## Honest evaluation

The failure that sells adaptive signals badly: run each plan once, report the
difference, call a result inside the noise a 20% improvement.

So every comparison runs across multiple seeds and **a result that does not hold
on every seed is reported `inconclusive`, not as a smaller improvement**. The
pipeline only recommends candidates whose verdict is `improvement`. Every
evaluation carries its own limitations in the output, including a warning when a
movement is oversaturated — a queue model understates delay past capacity, so
the real figure is worse than shown.

## What the model is

A deterministic queue-based (mesoscopic) simulation: seeded Poisson arrivals per
movement, discharge at saturation flow during green, delay accumulated over the
standing queue. Determinism is a requirement, not a convenience — an advisory
tool whose numbers move between runs cannot be reviewed.

It has no car-following, no lane-changing, no gap acceptance for permitted
turns, no pedestrian delay, and no network. It can tell a city that plan B
clears the queue faster than plan A at this intersection. It cannot tell them
what happens at the next junction downstream.

## What is not built

- **Calibration.** There is no fitting of the model against observed counts and
  no goodness-of-fit metric, so no ROI figure should leave this tool yet. That
  is the first thing to add before a real pilot.
- **Coordination.** One intersection. Corridor progression — the thing that
  actually produces the headline numbers in the literature — needs offsets and a
  network model.
- **An optimiser.** Candidate plans come in as input; nothing searches the
  timing space. The safety screen and the evaluator are the parts that had to be
  right first.
- **OpenStreetMap import.** Networks are hand-specified data.

## Selling it

The pitch is "prove the benefit before the capital spend", and the reason to
believe it is the audit trail: which candidates were discarded and why, how many
seeds agreed, what the model cannot see. Resist any framing that implies live
control. The advisory boundary is the product's liability position, and it is
enforced in `assertExportable` rather than in the contract.
