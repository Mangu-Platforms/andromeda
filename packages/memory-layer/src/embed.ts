/**
 * Deterministic embeddings with no dependencies and no network.
 *
 * A hashed bag of words is not a sentence encoder, and it is not pretending to
 * be one: it gives lexical-overlap similarity that is stable across processes
 * and machines, which is what a locally-owned index needs. The retrieval score
 * combines it with an explicit keyword term and a recency term precisely
 * because the vector alone is weak — see `memory-index.ts`.
 *
 * Swapping in a real on-device sentence encoder means replacing `embed` and
 * rebuilding the index; nothing else in the package depends on how the vector
 * was produced.
 */

export const EMBEDDING_DIMS = 256;

/** Words carrying no retrieval signal. Kept short on purpose; this is not NLP. */
const STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "but", "by", "did", "do", "does", "for", "from",
  "had", "has", "have", "he", "her", "him", "his", "i", "if", "in", "into", "is", "it", "its",
  "me", "my", "of", "on", "or", "our", "she", "so", "that", "the", "their", "them", "then",
  "there", "they", "this", "to", "was", "we", "were", "what", "when", "where", "which", "who",
  "will", "with", "you", "your",
]);

export function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 2) continue;
    if (STOPWORDS.has(raw)) continue;
    out.push(raw);
  }
  return out;
}

/** FNV-1a, 32-bit. Chosen because it is short, stable, and has no dependencies. */
export function hashToken(token: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < token.length; i++) {
    hash ^= token.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/**
 * L2-normalised hashed bag of words with sublinear term weighting, so a word
 * repeated ten times does not drown out the rest of the sentence.
 */
export function embed(text: string, dims = EMBEDDING_DIMS): number[] {
  const counts = new Map<string, number>();
  for (const token of tokenize(text)) counts.set(token, (counts.get(token) ?? 0) + 1);

  const vector = new Array<number>(dims).fill(0);
  for (const [token, count] of counts) {
    const bucket = hashToken(token) % dims;
    // A second bucket from a derived hash halves the damage of a collision.
    const shadow = hashToken(`${token}#`) % dims;
    const weight = 1 + Math.log(count);
    vector[bucket] = (vector[bucket] ?? 0) + weight;
    vector[shadow] = (vector[shadow] ?? 0) + weight * 0.5;
  }

  let norm = 0;
  for (const value of vector) norm += value * value;
  if (norm === 0) return vector;
  norm = Math.sqrt(norm);
  for (let i = 0; i < vector.length; i++) vector[i] = (vector[i] ?? 0) / norm;
  return vector;
}

/** Both vectors are unit length, so this is a dot product. */
export function cosine(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  let sum = 0;
  for (let i = 0; i < n; i++) sum += (a[i] ?? 0) * (b[i] ?? 0);
  return sum;
}
