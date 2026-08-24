import { verifyMandate } from "./mandate.ts";
import type { Decision, Mandate, OfferOnTable, Package, SealedMandate } from "./types.ts";
import { improve, packageForUtility, packageUtility } from "./utility.ts";

/**
 * The decision.
 *
 * Deliberately a pure function of (sealed mandate, offer, round). It takes no
 * provider, no message text, no model output, and no counterpart-authored
 * string of any kind — those are not parameters it has. That is the anchoring
 * defence stated as a signature: there is no argument through which persuasion
 * could enter, so persuasion cannot change the outcome.
 *
 * The dialogue model's job is to write the words around whatever this returns.
 */

/** What the frozen schedule asks for in a given round. */
export function askUtilityFor(mandate: Mandate, round: number): number {
  const { reservationUtility: reservation, aspirationUtility: aspiration, rounds } = mandate;
  if (rounds <= 1) return reservation;
  const t = Math.min(1, Math.max(0, (round - 1) / (rounds - 1)));

  // Fraction of the aspiration-to-reservation gap still demanded at time t.
  const remaining =
    mandate.concessionShape === "boulware"
      ? (1 - t) ** (1 / 3) // decays slowly, then collapses at the deadline
      : mandate.concessionShape === "conceder"
        ? (1 - t) ** 3 // gives most of the gap away in the early rounds
        : 1 - t; // linear

  return reservation + (aspiration - reservation) * remaining;
}

export interface DecideOptions {
  sealed: SealedMandate;
  offer: OfferOnTable;
  /** Operator-held key; the mandate is re-verified on every decision. */
  key: string;
}

export function decide(options: DecideOptions): Decision {
  // Integrity first. A mandate that has moved is not a mandate.
  const mandate = verifyMandate(options.sealed, options.key);
  const { offer } = options;

  const offerUtility = packageUtility(mandate.issues, offer.package, "user");
  const askUtility = askUtilityFor(mandate, offer.round);
  const reservation = mandate.reservationUtility;
  const rationale: string[] = [];
  const epsilon = 1e-9;

  const base = (kind: Decision["kind"]): Decision => ({
    kind,
    round: offer.round,
    offerUtility: Number(offerUtility.toFixed(6)),
    askUtility: Number(askUtility.toFixed(6)),
    reservationUtility: reservation,
    mandateDigest: options.sealed.digest,
    rationale,
  });

  if (offerUtility >= askUtility - epsilon) {
    rationale.push(
      `offer scores ${offerUtility.toFixed(3)}, at or above this round's ask of ${askUtility.toFixed(3)}`,
    );
    return base("accept");
  }

  if (offer.round >= mandate.rounds) {
    // Last round. The only question left is the one the reservation value
    // answers, and it was answered before the negotiation opened.
    if (offerUtility >= reservation - epsilon) {
      rationale.push(
        `final round: ${offerUtility.toFixed(3)} clears the reservation line of ${reservation.toFixed(3)}`,
      );
      return base("accept");
    }
    rationale.push(
      `final round: ${offerUtility.toFixed(3)} is below the reservation line of ${reservation.toFixed(3)}`,
      `the pre-committed outside option (${mandate.batnaLabel}) is worth more than this deal`,
    );
    return base("walk_away");
  }

  rationale.push(
    `offer scores ${offerUtility.toFixed(3)}, below this round's ask of ${askUtility.toFixed(3)}`,
    offerUtility < reservation
      ? `it is also below the reservation line of ${reservation.toFixed(3)}`
      : `it clears the reservation line, but there are rounds left to trade`,
  );
  return base("counter");
}

/**
 * The package to counter with: worth the round's ask, and pushed onto the
 * Pareto frontier before it is offered.
 *
 * Leaving a dominated package on the table is a real loss — it is worse for
 * *both* sides than something available — so the improvement loop runs until
 * no pairwise trade helps.
 */
export function counterPackage(mandate: Mandate, round: number): Package {
  let pkg = packageForUtility(mandate.issues, askUtilityFor(mandate, round));
  for (let i = 0; i < 32; i++) {
    const better = improve(mandate.issues, pkg);
    if (!better) break;
    pkg = better;
  }
  return pkg;
}

/** True when a deal exists that beats both sides' walk-away points. */
export function zopaExists(mandate: Mandate): boolean {
  // The user's own reservation package is the least they will take; if even
  // that leaves the counterpart above their estimated reservation, a zone
  // exists.
  const atReservation = packageForUtility(mandate.issues, mandate.reservationUtility);
  const counterpartValue = packageUtility(mandate.issues, atReservation, "counterpart");
  return counterpartValue >= mandate.counterpartReservationEstimate;
}
