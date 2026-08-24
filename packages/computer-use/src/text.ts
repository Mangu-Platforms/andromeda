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

/** True when `value` contains a C0 control character or DEL — newlines included. */
export function hasControlChars(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code < SPACE || code === DELETE) return true;
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
    out += code < SPACE || code === DELETE ? " " : char;
  }
  out = out.replace(/ {2,}/g, " ").trim();
  return out.length > maxLength ? `${out.slice(0, maxLength - 1)}…` : out;
}
