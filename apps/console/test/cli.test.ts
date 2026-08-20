import { test } from "node:test";
import assert from "node:assert/strict";

import { parseArgs } from "../src/cli.ts";

test("flags, values and positionals are separated", () => {
  const args = parseArgs(["build", "make me a thing", "--by", "dana@example.com", "--approve"]);
  assert.equal(args.command, "build");
  assert.deepEqual(args.positional, ["make me a thing"]);
  assert.equal(args.flags.by, "dana@example.com");
  assert.equal(args.flags.approve, true);
});

test("a flag followed by another flag is a boolean, not a value", () => {
  const args = parseArgs(["approve", "run_1", "--approve", "--by", "dana"]);
  assert.equal(args.flags.approve, true);
  assert.equal(args.flags.by, "dana");
});

test("an empty argv asks for help rather than doing something", () => {
  assert.equal(parseArgs([]).command, "help");
});

test("a description that looks like a flag value is kept positional", () => {
  const args = parseArgs(["build", "--by", "dana", "a tool for --reports"]);
  assert.deepEqual(args.positional, ["a tool for --reports"]);
  assert.equal(args.flags.by, "dana");
});
