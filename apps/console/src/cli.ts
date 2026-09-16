import { AuditLog, systemClock } from "@andromeda/core";
import { proposalFromRun, type BuildResult } from "@andromeda/autobuilder";
import {
  createConsoleApp,
  deliveryFromEnv,
  providerFromEnv,
  storeFromEnv,
  type ConsoleApp,
} from "./app.ts";

/**
 * Headless driver for the same pipeline the console serves.
 *
 * Useful for CI and for scripting, and it keeps the approval step honest:
 * `build` stops at the gate like everything else, and `--approve` is a
 * separate, explicitly named act rather than a default.
 */
const USAGE = `andromeda — auto-builder CLI

  build "<description>" --by <name> [--approve] [--budget <usd>]
      Compile, scaffold, generate test-gated features, and stop for review.
      --approve approves the resulting build immediately, under your name.

  list                          Show every build.
  show <run-id>                 Show one build in detail.
  approve <run-id> --by <name> [--note <text>]
  reject  <run-id> --by <name> [--note <text>]
  templates                     Show the registered scaffolds and their pins.

Environment:
  ANTHROPIC_API_KEY     Run against a live model. Without it, recorded fixtures
                        are replayed and no request leaves the machine.
  ANDROMEDA_STATE_DIR   Where build state is kept (default ./.andromeda/state).
  ANDROMEDA_OUT_DIR     Where approved builds are written (default ./.andromeda/out).
`;

interface Args {
  command: string;
  positional: string[];
  flags: Record<string, string | boolean>;
}

export function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i] as string;
    if (!token.startsWith("--")) {
      positional.push(token);
      continue;
    }
    const name = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      flags[name] = true;
    } else {
      flags[name] = next;
      i++;
    }
  }

  return { command: positional.shift() ?? "help", positional, flags };
}

async function app(flags: Record<string, string | boolean>): Promise<ConsoleApp> {
  // Same environment seams as the server, so a CLI `approve` acts on the very
  // run the console is showing — not a parallel file-backed copy of it.
  const [llm, store, delivery] = await Promise.all([
    providerFromEnv(),
    storeFromEnv(),
    deliveryFromEnv(),
  ]);
  return createConsoleApp({
    stateDir: process.env.ANDROMEDA_STATE_DIR ?? "./.andromeda/state",
    outputDir: process.env.ANDROMEDA_OUT_DIR ?? "./.andromeda/out",
    budgetUsd: Number(flags.budget ?? process.env.ANDROMEDA_BUDGET_USD ?? 5),
    ...(process.env.ANDROMEDA_GLOBAL_BUDGET_USD !== undefined
      ? { globalBudgetUsd: Number(process.env.ANDROMEDA_GLOBAL_BUDGET_USD) }
      : {}),
    ...(llm ? { llm } : {}),
    ...(store ? { store } : {}),
    ...(delivery ? { delivery } : {}),
  });
}

const require_ = (value: unknown, message: string): string => {
  if (typeof value !== "string" || !value.trim()) {
    console.error(`error: ${message}`);
    process.exitCode = 2;
    throw new Error(message);
  }
  return value.trim();
};

export async function run(argv: string[]): Promise<void> {
  const { command, positional, flags } = parseArgs(argv);

  if (command === "help" || flags.help) {
    console.log(USAGE);
    return;
  }

  const context = await app(flags);
  if (context.demoMode && command === "build") {
    console.log("demo mode: replaying fixtures (set ANTHROPIC_API_KEY to run live)\n");
  }

  switch (command) {
    case "build": {
      const intent = require_(positional[0], 'describe what to build: build "<description>"');
      const requestedBy = require_(flags.by, "--by <name> is required");

      let record = await context.runner.start(context.workflow, { intent, requestedBy });
      printRun(record);

      if (record.status === "suspended" && flags.approve) {
        const pending = (await context.gate.listForRun(record.id)).find(
          (r) => r.status === "pending",
        );
        if (pending) {
          const audit = await AuditLog.open(context.store, systemClock, record.id);
          await context.gate.decide(pending.id, "approved", requestedBy, "approved via --approve", audit);
          record = await context.runner.resume(context.workflow, record.id, {
            status: "approved",
            decidedBy: requestedBy,
            note: "approved via --approve",
          });
          printRun(record);
        }
      } else if (record.status === "suspended") {
        console.log(`\nreview it:  andromeda show ${record.id}`);
        console.log(`approve it: andromeda approve ${record.id} --by <name>`);
      }
      return;
    }

    case "list": {
      const runs = await context.runner.list();
      if (runs.length === 0) {
        console.log("no builds yet");
        return;
      }
      for (const record of runs) {
        const name = proposalFromRun(record)?.projectName ?? "-";
        console.log(
          `${record.id}  ${record.status.padEnd(10)}  ${name.padEnd(24)}  $${record.spentUsd.toFixed(4)}`,
        );
      }
      return;
    }

    case "show": {
      const runId = require_(positional[0], "show <run-id>");
      const record = await context.runner.get(runId);
      if (!record) {
        console.error(`no build ${runId}`);
        process.exitCode = 1;
        return;
      }
      printRun(record, { verbose: true });
      const events = await new AuditLog(context.store, systemClock, runId).events();
      console.log("\naudit trail:");
      for (const event of events) {
        console.log(`  ${event.kind.padEnd(16)} ${event.summary}`);
      }
      return;
    }

    case "approve":
    case "reject": {
      const runId = require_(positional[0], `${command} <run-id>`);
      const decidedBy = require_(flags.by, "--by <name> is required");
      const note = typeof flags.note === "string" ? flags.note : "";

      const pending = (await context.gate.listForRun(runId)).find((r) => r.status === "pending");
      if (!pending) {
        console.error(`build ${runId} has no pending approval`);
        process.exitCode = 1;
        return;
      }
      const status = command === "approve" ? "approved" : "rejected";
      const audit = await AuditLog.open(context.store, systemClock, runId);
      await context.gate.decide(pending.id, status, decidedBy, note, audit);
      printRun(await context.runner.resume(context.workflow, runId, { status, decidedBy, note }));
      return;
    }

    case "templates": {
      for (const template of context.registry.list()) {
        console.log(`${template.id}@${template.version}  ${template.description}`);
        const pins = { ...template.dependencies, ...template.devDependencies };
        for (const [pkg, version] of Object.entries(pins).sort()) {
          console.log(`    ${pkg}@${version}`);
        }
      }
      return;
    }

    default:
      console.error(`unknown command "${command}"\n`);
      console.log(USAGE);
      process.exitCode = 2;
  }
}

function printRun(record: Parameters<typeof proposalFromRun>[0], options: { verbose?: boolean } = {}): void {
  const proposal = proposalFromRun(record);
  const result = record.result as BuildResult | null;

  console.log(`run       ${record.id}`);
  console.log(`status    ${record.status}${result ? ` (${result.outcome})` : ""}`);
  console.log(`spend     $${record.spentUsd.toFixed(4)}`);

  if (record.error) console.log(`error     ${record.error.message}`);
  if (!proposal) return;

  console.log(`project   ${proposal.projectName}`);
  console.log(`template  ${proposal.templateId}@${proposal.templateVersion}`);
  console.log(`files     ${proposal.files.length}`);
  console.log(`risk      ${proposal.risk.score}/100`);
  for (const factor of proposal.risk.factors) console.log(`          - ${factor}`);

  for (const build of proposal.featureBuilds) {
    const verdict = build.passed
      ? `passed after ${build.attempts.length} attempt(s)`
      : `FAILED after ${build.attempts.length} attempt(s)`;
    console.log(`feature   ${build.featureId}: ${verdict}`);
  }

  if (result?.receipt) console.log(`delivered ${result.receipt.location}`);
  if (result?.outcome === "blocked_by_test_gate") {
    console.log("\nblocked: a feature never passed its tests, so no approval was requested.");
    if (options.verbose) {
      for (const build of proposal.featureBuilds.filter((b) => !b.passed)) {
        console.log(`\n--- ${build.featureId} test output ---\n${build.testOutput}`);
      }
    }
  }
}

if (process.argv[1]?.endsWith("cli.ts")) {
  await run(process.argv.slice(2));
}
