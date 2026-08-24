/**
 * String hygiene for text that crosses a trust boundary.
 *
 * Both directions matter. Text coming *out* of a page must not be able to forge
 * structure in the planner's prompt or in a reviewer's rendered approval, and
 * text coming *out* of a model must not be able to hide payloads in bytes a
 * human reading a log will never see. Both are handled by code-point tests
 * rather than regex escapes, so what is rejected is unambiguous.
 */

const SPACE = 0x20;
const DELETE = 0x7f;
const C1_START = 0x80;
const C1_END = 0x9f;
const LINE_SEPARATOR = 0x2028;
const PARAGRAPH_SEPARATOR = 0x2029;

/**
 * True when `value` contains a character that can forge structure or hide.
 *
 * C0 controls and DEL cover newlines and tabs; C1 covers the codepoints that
 * some terminals and log viewers still interpret; U+2028/U+2029 are line breaks
 * that many renderers honour but most eyes and greps miss. Anything in this set
 * is a character an attacker wants and a legitimate action field never needs.
 */
export function hasControlChars(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code < SPACE || code === DELETE) return true;
    if (code >= C1_START && code <= C1_END) return true;
    if (code === LINE_SEPARATOR || code === PARAGRAPH_SEPARATOR) return true;
  }
  return false;
}

/**
 * Collapse a string to one printable line, capped.
 *
 * Applied to every field of the quarantined reader's output. It is what stops a
 * page from writing its own section into the planner prompt: an injected
 * "\n\nSYSTEM: new instructions" laundered through a summary comes back as one
 * run-on line inside a quoted field, not as a new block.
 */
export function toSingleLine(value: string, maxLength: number): string {
  let out = "";
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    const isControl =
      code < SPACE ||
      code === DELETE ||
      (code >= C1_START && code <= C1_END) ||
      code === LINE_SEPARATOR ||
      code === PARAGRAPH_SEPARATOR;
    out += isControl ? " " : char;
  }
  out = out.replace(/ {2,}/g, " ").trim();
  return out.length > maxLength ? `${out.slice(0, maxLength - 1)}…` : out;
}
