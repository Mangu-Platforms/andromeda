import type { LiteratureSource, Paper, SearchQuery } from "./types.ts";

/**
 * An offline stand-in for Semantic Scholar / OpenAlex.
 *
 * The corpus is small and fictional on purpose: a test that asserts a
 * fabricated citation is refused must not depend on what a live index happens
 * to hold today, and the whole package has to run with no network. Swapping in
 * a real client is a one-file change — the ledger, the verifier and the
 * pipeline only ever see `LiteratureSource`.
 */
export class FixtureLiteratureSource implements LiteratureSource {
  readonly id: string;
  readonly #papers: Paper[];
  readonly #maxLimit: number;

  constructor(papers: Paper[] = FIXTURE_CORPUS, options: { id?: string; maxLimit?: number } = {}) {
    this.id = options.id ?? "fixture";
    this.#papers = papers;
    this.#maxLimit = options.maxLimit ?? 10;
  }

  async search(query: SearchQuery): Promise<Paper[]> {
    const limit = Math.max(1, Math.min(query.limit ?? 5, this.#maxLimit));
    const terms = tokenize(query.terms);
    if (terms.length === 0) return [];

    const scored = this.#papers
      .filter((p) => (query.yearFrom === undefined ? true : p.year >= query.yearFrom))
      .map((paper) => ({ paper, score: score(paper, terms) }))
      .filter(({ score: s }) => s > 0)
      // Ties break on id so the same query always returns the same order —
      // a run replayed from its checkpoints must see the same corpus.
      .sort((a, b) => b.score - a.score || (a.paper.id < b.paper.id ? -1 : 1));

    return scored.slice(0, limit).map(({ paper }) => structuredClone(paper));
  }
}

const tokenize = (text: string): string[] =>
  text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 2 && !STOPWORDS.has(word));

const STOPWORDS = new Set([
  "the", "and", "for", "with", "how", "does", "are", "was", "were", "that",
  "this", "from", "into", "what", "which", "can", "any", "its", "has",
]);

function score(paper: Paper, terms: string[]): number {
  const title = paper.title.toLowerCase();
  const abstract = paper.abstract.toLowerCase();
  let total = 0;
  for (const term of terms) {
    if (title.includes(term)) total += 3;
    if (abstract.includes(term)) total += 1;
  }
  return total;
}

/**
 * Six fictional papers on one narrow question, with enough disagreement
 * between them that an honest review has to record a limitation.
 */
export const FIXTURE_CORPUS: Paper[] = [
  {
    id: "fx-0001",
    title: "Sleep restriction and consolidation of motor sequence learning",
    authors: ["Okonkwo, A.", "Lindqvist, M.", "Baptista, R."],
    year: 2019,
    venue: "Journal of Cognitive Neuroscience Reports",
    doi: "10.9999/jcnr.2019.0141",
    url: "https://example.invalid/papers/fx-0001",
    abstract:
      "We examined whether restricting sleep to four hours impairs overnight consolidation of a finger-tapping sequence task. Across 48 healthy adults, restricted sleepers showed a 12 percent smaller overnight improvement in tapping speed than controls, with no difference in error rate. The effect was concentrated in participants who lost slow-wave sleep rather than REM. We conclude that slow-wave sleep, and not total sleep time, predicts consolidation gains in this task.",
  },
  {
    id: "fx-0002",
    title: "A registered replication of overnight motor consolidation effects",
    authors: ["Halvorsen, P.", "Ito, K."],
    year: 2022,
    venue: "Registered Reports in Psychology",
    doi: "10.9999/rrp.2022.0088",
    url: "https://example.invalid/papers/fx-0002",
    abstract:
      "In a pre-registered replication with 210 participants across three sites, we failed to reproduce the reported association between slow-wave sleep duration and overnight motor improvement. The point estimate was close to zero and the confidence interval excluded the originally reported effect size. Site-level heterogeneity was substantial, and two of the three sites produced effects in opposite directions. We caution against treating single-site consolidation findings as settled.",
  },
  {
    id: "fx-0003",
    title: "Slow-wave activity as a biomarker of memory consolidation: a meta-analysis",
    authors: ["Duarte, C.", "Nwosu, E.", "Fisher, T."],
    year: 2021,
    venue: "Sleep Medicine Synthesis",
    doi: "10.9999/sms.2021.0310",
    url: "https://example.invalid/papers/fx-0003",
    abstract:
      "We pooled 34 studies covering 2,914 participants to estimate the association between slow-wave activity and post-sleep memory performance. The random-effects estimate was small but positive, and heterogeneity was high. Funnel-plot asymmetry and a trim-and-fill adjustment both suggest publication bias inflates the naive estimate. After adjustment the pooled effect is no longer distinguishable from zero for motor tasks, though it remains positive for declarative material.",
  },
  {
    id: "fx-0004",
    title: "Napping, caffeine, and afternoon procedural skill retention",
    authors: ["Marchetti, L.", "Osei, D."],
    year: 2020,
    venue: "Applied Chronobiology Letters",
    doi: "10.9999/acl.2020.0022",
    url: "https://example.invalid/papers/fx-0004",
    abstract:
      "Ninety participants took a twenty-minute nap, consumed 200 mg of caffeine, or rested quietly before an afternoon retest of a procedural typing task. Nappers retained more skill than the quiet-rest group, while caffeine produced faster reaction times but no retention benefit. Retention advantages disappeared when participants were retested a week later, suggesting the nap effect is short-lived.",
  },
  {
    id: "fx-0005",
    title: "Measurement error in consumer sleep trackers and its effect on published estimates",
    authors: ["Reinholt, S.", "Achebe, N.", "Vogel, J."],
    year: 2023,
    venue: "Methods in Sleep Research",
    doi: "10.9999/msr.2023.0407",
    url: "https://example.invalid/papers/fx-0005",
    abstract:
      "Consumer wrist trackers misclassify slow-wave sleep against polysomnography with epoch-level agreement below 60 percent in our sample of 120 nights. Simulations show that this level of misclassification attenuates a true association by roughly half, and can flip the sign of an estimate when sample sizes are small. Studies relying on consumer trackers should be treated as providing weaker evidence than laboratory polysomnography.",
  },
  {
    id: "fx-0006",
    title: "Do sleep interventions improve surgical skill acquisition? A pragmatic trial",
    authors: ["Bergström, H.", "Qadir, F.", "Adeyemi, T."],
    year: 2024,
    venue: "Trials in Medical Education",
    doi: "10.9999/tme.2024.0155",
    url: "https://example.invalid/papers/fx-0006",
    abstract:
      "We randomised 156 surgical trainees to a sleep-extension programme or usual scheduling over eight weeks and measured laparoscopic skill on a validated simulator. The sleep-extension arm slept 51 minutes longer per night on average but did not differ significantly in simulator score at the primary endpoint. A pre-specified subgroup of trainees under 30 showed a modest benefit, which we report as exploratory and not confirmatory.",
  },
];
