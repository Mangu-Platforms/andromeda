import { test } from "node:test";
import assert from "node:assert/strict";

import { DomainAllowlist } from "../src/policy/allowlist.ts";

const allow = new DomainAllowlist(["example.com", "docs.example.org"]);

test("an exact host match is allowed", () => {
  assert.equal(allow.allows("https://example.com/"), true);
  assert.equal(allow.allows("https://example.com/a/b?c=d#e"), true);
  assert.equal(allow.allows("https://docs.example.org/guide"), true);
});

test("lookalike hosts that fool substring matching are refused", () => {
  // Each of these contains "example.com" as a substring, and each is a
  // different host. This is the check naive allowlists get wrong.
  for (const url of [
    "https://evil-example.com/",
    "https://notexample.com/",
    "https://example.com.attacker.net/",
    "https://example.company/",
  ]) {
    assert.equal(allow.allows(url), false, `${url} should be refused`);
  }
});

test("subdomains are refused unless explicitly enabled", () => {
  assert.equal(allow.allows("https://mail.example.com/"), false);

  const withSubs = new DomainAllowlist(["example.com"], { includeSubdomains: true });
  assert.equal(withSubs.allows("https://mail.example.com/"), true);
  // Label-wise, so the suffix trick still fails.
  assert.equal(withSubs.allows("https://evil-example.com/"), false);
  assert.equal(withSubs.allows("https://example.com.attacker.net/"), false);
});

test("embedded credentials are refused even when the real host matches", () => {
  // The host here is evil.com. Refused outright so no audit line can mislead.
  assert.equal(allow.allows("https://example.com@evil.com/"), false);
  // And when the *real* host is allowlisted, still refused — a URL a reviewer
  // would misread has no place in the log.
  assert.equal(allow.allows("https://evil.com@example.com/"), false);
});

test("case and trailing-dot variants normalise rather than bypass", () => {
  assert.equal(allow.allows("https://EXAMPLE.COM/"), true);
  assert.equal(allow.allows("https://ExAmPlE.cOm/path"), true);
  // A trailing dot is the same host to DNS but a different string to a
  // comparison, so it is refused rather than silently accepted.
  assert.equal(allow.allows("https://example.com./"), false);
});

test("unicode lookalikes are refused, not resolved", () => {
  // Cyrillic а in "exаmple.com" — visually identical, different host.
  assert.equal(allow.allows("https://exаmple.com/"), false);
  assert.equal(allow.allows("https://xn--exmple-4nf.com/"), false);
});

test("non-https schemes never reach a host check", () => {
  for (const url of [
    "javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "file:///etc/passwd",
    "blob:https://example.com/uuid",
    "http://example.com/",
  ]) {
    assert.equal(allow.allows(url), false, `${url} should be refused`);
  }
});

test("IP literals are never a match for a name", () => {
  for (const url of [
    "https://127.0.0.1/",
    "https://[::1]/",
    // Decimal form of 127.0.0.1; the URL parser canonicalises it.
    "https://2130706433/",
    "https://169.254.169.254/latest/meta-data/",
  ]) {
    assert.equal(allow.allows(url), false, `${url} should be refused`);
  }
});

test("non-default ports are refused", () => {
  assert.equal(allow.allows("https://example.com:8443/"), false);
});

test("input that is not a parseable absolute URL is refused", () => {
  for (const value of ["", "   ", "example.com", "/relative", null, undefined, 42, {}]) {
    assert.equal(allow.allows(value), false, `${String(value)} should be refused`);
  }
});

test("a refusal always says why", () => {
  const verdict = allow.check("https://evil.example/");
  assert.equal(verdict.ok, false);
  assert.match(verdict.ok ? "" : verdict.reason, /not on the allowlist/);
});

test("a malformed allowlist entry fails at construction, not silently", () => {
  // An allowlist that matches nothing looks exactly like one that works.
  assert.throws(() => new DomainAllowlist([]), /empty allowlist/);
  assert.throws(() => new DomainAllowlist(["https://example.com"]), /bare hostname/);
  assert.throws(() => new DomainAllowlist(["*.example.com"]), /bare hostname/);
  assert.throws(() => new DomainAllowlist(["example.com:443"]), /bare hostname/);
  assert.throws(() => new DomainAllowlist(["127.0.0.1"]), /IP literal/);
  assert.throws(() => new DomainAllowlist(["localhost"]), /not a valid hostname/);
  assert.throws(() => new DomainAllowlist(["xn--exmple-4nf.com"]), /punycode/);
  assert.throws(() => new DomainAllowlist([""]), /empty/);
});
