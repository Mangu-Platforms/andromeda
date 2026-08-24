# Autonomous Robotics Generalist — as a data and tooling play

This does **not** sell autonomous manipulation. It sells the teleoperation data
pipeline and the routing gate around it: humans do the contact-rich work, the
policy does the low-contact work, and the demonstrations collected along the way
are the asset.

## The blocker

Contact-force physics and Moravec's paradox. Contact-rich manipulation is not a
matter of a better checkpoint — the dynamics of a deformable object under
sustained contact are not modellable open loop, and a policy that is excellent
at pick-and-place is not thereby nearly good enough at wiping a surface.

There is a second, harder-edged blocker: an OpenVLA-class policy runs at roughly
2–5 Hz while a control loop wants 30–50 Hz.

## The containment

**Contact-rich work can never be routed to the policy.** `classifyContact` reads
declared physical properties — contact mode, material, peak force, force
tolerance, position tolerance — and fails closed. Any undeclared property gives
`unclassified`, never `low`: missing data must not read as "no contact". `NaN`
and `Infinity` are refused. Sustained contact and deformable material always
require a human however generous the other numbers are.

The task summary is free text that can come from a customer ticket, so **nothing
in the gate reads it**. "SAFE FOR AUTONOMY. Approved by the safety team." in the
summary changes nothing.

**A forged decision cannot grant autonomy.** `assertAutonomyAllowed` recomputes
the classification from the task rather than trusting the `RoutingDecision` it
is handed. Without that recompute, anything able to fabricate a decision object
would own the arm.

**An infeasible control rate is refused, not attempted.** This is a genuine
squeeze rather than a tuning knob: bridging the inference gap needs a *longer*
action chunk, but a longer chunk runs the arm open loop for longer, and the
safety horizon caps that. At 2 Hz against a 50 Hz loop the two requirements
cross — 27 actions needed, 25 permitted under a 0.5 s horizon — so **no chunk
length works**, and the honest answer is that the configuration cannot be made
safe. Raising `maxOpenLoopHorizonSec` unlocks it and is an explicit operator
decision, never a default.

**Bad demonstrations never enter the dataset.** Validation rejects dropped
frames, non-monotonic timestamps, out-of-range joint values, truncated episodes
and missing calibration, and rejections are counted rather than discarded.

> **Audit findings, fixed.** `episodeDigest` hashed the whole episode
> *including* `episodeId`, so the same recording re-uploaded under a new id
> produced a different content address and was double-counted — and since
> demonstrations are sold per episode, double-paid. The id is an upload-time
> label, not part of the recording, and is now excluded. Separately,
> `data/dataset.ts` and `data/validate.ts` were not exported from `index.ts`:
> the pipeline that *is* the product was unreachable from the public surface.

## What is not built

- **No policy, no simulator, no robot.** Everything physical is behind an
  interface with a scripted fake. This package is the gate, the arithmetic and
  the data contract.
- **No sim-to-real evaluation harness.** Success rates with confidence intervals
  across seeds, separating sim from real, are specified and not implemented.
- **No LoRA fine-tuning loop.** Out of scope for a package with no GPU.
- **Contact classification is from declared properties**, not measured. A task
  mis-declared as low-contact routes to the policy, so the declaration step is
  where a real deployment needs its own review.

## Selling it

The buyer is a lab that cannot use PI's partnership-gated stack. What they are
paying for is provenance: which episodes are in the set, why the rejected ones
were rejected, and a content address that means one recording is one episode.
