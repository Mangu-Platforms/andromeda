import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";

import { LocalSandbox } from "../src/sandbox/local.ts";

test("files are written and read back inside the root", async (t) => {
  const sandbox = await LocalSandbox.create();
  t.after(() => sandbox.dispose());

  await sandbox.writeFiles([
    { path: "a/b/c.txt", contents: "hello" },
    { path: "package.json", contents: "{}" },
  ]);

  assert.equal(await sandbox.readFile("a/b/c.txt"), "hello");
  assert.equal(await sandbox.exists("package.json"), true);
  assert.equal(await sandbox.exists("nope.txt"), false);
});

test("paths that climb out of the root are refused", async (t) => {
  const sandbox = await LocalSandbox.create();
  t.after(() => sandbox.dispose());

  for (const path of ["../escape.txt", "a/../../escape.txt", "/etc/passwd", ""]) {
    await assert.rejects(
      () => sandbox.writeFiles([{ path, contents: "x" }]),
      /escapes the sandbox root/,
      `expected "${path}" to be refused`,
    );
  }
  assert.equal(existsSync("/tmp/escape.txt"), false);
});

test("commands run without a shell, so arguments are never interpreted", async (t) => {
  const sandbox = await LocalSandbox.create();
  t.after(() => sandbox.dispose());

  // Under a shell this would substitute a command; as an argv entry it is data.
  const result = await sandbox.exec("node", ["-e", "console.log(process.argv[1])", "$(id)"]);
  assert.equal(result.code, 0);
  assert.equal(result.stdout.trim(), "$(id)");
});

test("a runaway process is killed at the timeout", async (t) => {
  const sandbox = await LocalSandbox.create();
  t.after(() => sandbox.dispose());

  const result = await sandbox.exec("node", ["-e", "setInterval(() => {}, 1000)"], {
    timeoutMs: 500,
  });
  assert.equal(result.timedOut, true);
  assert.notEqual(result.code, 0);
  assert.ok(result.durationMs < 10_000, "the kill must not wait for the process to finish");
});

test("the parent process environment is not inherited", async (t) => {
  process.env.ANDROMEDA_FAKE_SECRET = "super-secret-value";
  t.after(() => {
    delete process.env.ANDROMEDA_FAKE_SECRET;
  });

  const sandbox = await LocalSandbox.create();
  t.after(() => sandbox.dispose());

  const result = await sandbox.exec("node", [
    "-e",
    "console.log(JSON.stringify({ secret: process.env.ANDROMEDA_FAKE_SECRET ?? null, home: process.env.HOME }))",
  ]);
  const env = JSON.parse(result.stdout);
  // Generated code runs next to whatever credentials the operator's shell had.
  assert.equal(env.secret, null);
  assert.equal(env.home, sandbox.root);
});

test("a non-zero exit is reported rather than thrown", async (t) => {
  const sandbox = await LocalSandbox.create();
  t.after(() => sandbox.dispose());

  const result = await sandbox.exec("node", ["-e", "process.exit(3)"]);
  assert.equal(result.code, 3);
  assert.equal(result.timedOut, false);
});

test("disposing removes the whole working directory", async () => {
  const sandbox = await LocalSandbox.create();
  await sandbox.writeFiles([{ path: "x.txt", contents: "x" }]);
  const root = sandbox.root;
  assert.equal(existsSync(root), true);
  await sandbox.dispose();
  assert.equal(existsSync(root), false);
});
