import {
  ApprovalGate,
  FileStore,
  MemoryStore,
  WorkflowRunner,
  randomIds,
  systemClock,
  type LLMProvider,
  type Store,
} from "@andromeda/core";
import {
  LocalDirectoryDelivery,
  LocalSandbox,
  TemplateRegistry,
  createAutoBuilder,
  type DeliveryTarget,
} from "@andromeda/autobuilder";
import { demoProvider } from "./demo.ts";

export interface ConsoleApp {
  store: Store;
  gate: ApprovalGate;
  runner: WorkflowRunner;
  registry: TemplateRegistry;
  workflow: ReturnType<typeof createAutoBuilder>;
  /** True when no API key was configured and fixtures are being replayed. */
  demoMode: boolean;
}

export interface ConsoleOptions {
  /** Where run state lives. Omit for an in-memory store. Ignored if `store` is set. */
  stateDir?: string;
  /** A store to use directly — takes priority over `stateDir`. See `storeFromEnv`. */
  store?: Store;
  /** Where approved builds are written. Ignored if `delivery` is set. */
  outputDir?: string;
  /** Where approved builds go — takes priority over `outputDir`. See `deliveryFromEnv`. */
  delivery?: DeliveryTarget;
  /** Per-run spend ceiling in USD. */
  budgetUsd?: number;
  llm?: LLMProvider;
}

/**
 * Assemble the console.
 *
 * With no LLM provider configured this runs in demo mode against fixtures,
 * which keeps the whole review flow — including a failing first attempt and its
 * repair — runnable with no API key and no cloud account.
 */
export async function createConsoleApp(options: ConsoleOptions = {}): Promise<ConsoleApp> {
  const demoMode = !options.llm;
  const llm = options.llm ?? demoProvider();
  const store: Store = options.store ?? (options.stateDir ? new FileStore(options.stateDir) : new MemoryStore());
  const gate = new ApprovalGate(store, systemClock, randomIds);
  const registry = new TemplateRegistry();

  const workflow = createAutoBuilder({
    llm,
    registry,
    gate,
    delivery: options.delivery ?? new LocalDirectoryDelivery(options.outputDir ?? "./.andromeda/out"),
    createSandbox: () => LocalSandbox.create(),
  });

  return {
    store,
    gate,
    registry,
    workflow,
    demoMode,
    runner: new WorkflowRunner({
      store,
      clock: systemClock,
      ids: randomIds,
      budgetUsd: options.budgetUsd ?? 5,
    }),
  };
}

/**
 * Build a live provider from the environment, or null to stay in demo mode.
 *
 * Imported dynamically so a demo-mode console never loads the SDK.
 */
export async function providerFromEnv(): Promise<LLMProvider | null> {
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) return null;
  const { AnthropicProvider } = await import("@andromeda/core/anthropic");
  return new AnthropicProvider();
}

/**
 * Build a Supabase-backed store from the environment, or null to stay local
 * (an in-memory or on-disk store — see `ConsoleOptions`).
 *
 * Imported dynamically for the same reason as `providerFromEnv`: a console
 * with no Supabase project configured never touches this module.
 */
export async function storeFromEnv(): Promise<Store | null> {
  const { supabaseStoreFromEnv } = await import("@andromeda/core/supabase-store");
  return supabaseStoreFromEnv(process.env);
}

/**
 * Build a GitHub pull-request delivery from the environment, or null to
 * deliver to the local output directory. Requires `ANDROMEDA_DELIVERY_REPO`
 * (`owner/repo`) and `GITHUB_TOKEN`; the PR stays behind the same approval
 * gate as every other delivery.
 */
export async function deliveryFromEnv(): Promise<DeliveryTarget | null> {
  const { githubDeliveryFromEnv } = await import("@andromeda/autobuilder");
  return githubDeliveryFromEnv(process.env);
}
