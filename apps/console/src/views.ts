import type { ApprovalRequest, AuditEvent, RunRecord } from "@andromeda/core";
import type { BuildResult, FeatureBuild } from "@andromeda/autobuilder";
import { proposalFromRun } from "@andromeda/autobuilder";

/**
 * Escape text for HTML.
 *
 * Everything this console displays — specs, diffs, feature source, test output —
 * was written by a language model from an untrusted prompt. Escaping is the
 * control that keeps a generated `<script>` inert; the restrictive CSP on every
 * response is the second layer behind it.
 */
export function escapeHtml(value: unknown): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const STYLE = `
:root { color-scheme: light dark; --fg:#111; --muted:#666; --bg:#fff; --panel:#f6f6f7;
        --border:#d8d8dc; --accent:#2b5fd9; --good:#0a7a3d; --bad:#b3261e; --warn:#8a5a00; }
@media (prefers-color-scheme: dark) {
  :root { --fg:#e8e8ea; --muted:#9a9aa2; --bg:#131316; --panel:#1c1c21;
          --border:#33333c; --accent:#7aa2ff; --good:#4ad07f; --bad:#ff6b5e; --warn:#e0a44a; }
}
* { box-sizing: border-box; }
body { margin:0; padding:2rem 1.5rem; background:var(--bg); color:var(--fg); line-height:1.5;
       font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 60rem; margin: 0 auto; }
h1 { font-size:1.5rem; margin:0 0 .25rem; } h2 { font-size:1.1rem; margin:2rem 0 .75rem; }
a { color:var(--accent); } code, pre { font-family: ui-monospace, "SF Mono", Menlo, monospace; }
pre { background:var(--panel); border:1px solid var(--border); border-radius:6px;
      padding:.75rem; overflow-x:auto; font-size:.8rem; margin:0; }
table { width:100%; border-collapse:collapse; font-size:.9rem; }
th, td { text-align:left; padding:.5rem .6rem; border-bottom:1px solid var(--border); }
th { color:var(--muted); font-weight:600; font-size:.75rem; text-transform:uppercase;
     letter-spacing:.04em; }
.panel { background:var(--panel); border:1px solid var(--border); border-radius:8px;
         padding:1rem 1.15rem; margin-bottom:1rem; }
.muted { color:var(--muted); } .small { font-size:.85rem; }
.tag { display:inline-block; padding:.1rem .5rem; border-radius:99px; font-size:.75rem;
       border:1px solid var(--border); }
.good { color:var(--good); } .bad { color:var(--bad); } .warn { color:var(--warn); }
details { border:1px solid var(--border); border-radius:6px; margin-bottom:.4rem;
          background:var(--panel); }
summary { cursor:pointer; padding:.5rem .75rem; font-family: ui-monospace, Menlo, monospace;
          font-size:.82rem; }
details pre { border:0; border-top:1px solid var(--border); border-radius:0; }
form { display:flex; flex-wrap:wrap; gap:.5rem; align-items:center; }
input, textarea, button { font:inherit; padding:.5rem .6rem; border-radius:6px;
        border:1px solid var(--border); background:var(--bg); color:var(--fg); }
textarea { width:100%; min-height:5rem; }
button { cursor:pointer; border-color:var(--accent); color:var(--accent); font-weight:600; }
button.primary { background:var(--accent); color:#fff; }
button.danger { border-color:var(--bad); color:var(--bad); }
.bar { height:6px; border-radius:99px; background:var(--border); overflow:hidden; width:8rem;
       display:inline-block; vertical-align:middle; }
.bar > span { display:block; height:100%; background:var(--accent); }
`;

const page = (title: string, body: string): string => `<title>${escapeHtml(title)}</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>${STYLE}</style>
<main>${body}</main>`;

const money = (usd: number): string => `$${usd.toFixed(4)}`;

const statusTag = (record: RunRecord): string => {
  const result = record.result as BuildResult | null;
  if (record.status === "suspended") return `<span class="tag warn">awaiting review</span>`;
  if (record.status === "failed") return `<span class="tag bad">failed</span>`;
  if (record.status === "running") return `<span class="tag">running</span>`;
  const outcome = result?.outcome;
  if (outcome === "delivered") return `<span class="tag good">delivered</span>`;
  if (outcome === "rejected") return `<span class="tag bad">rejected</span>`;
  if (outcome === "blocked_by_test_gate") return `<span class="tag bad">blocked: tests red</span>`;
  return `<span class="tag">${escapeHtml(record.status)}</span>`;
};

export function dashboard(
  runs: RunRecord[],
  demoMode: boolean,
  decisions: Map<string, ApprovalRequest> = new Map(),
): string {
  const decisionCell = (run: RunRecord): string => {
    const approval = decisions.get(run.id);
    if (!approval) return `<span class="muted">—</span>`;
    if (approval.status === "pending") return `<span class="warn">pending</span>`;
    return `${escapeHtml(approval.status)}${
      approval.decidedBy ? ` by ${escapeHtml(approval.decidedBy)}` : ""
    }`;
  };
  const requester = (run: RunRecord): string => {
    const input = run.input as { requestedBy?: unknown } | null;
    return typeof input?.requestedBy === "string" ? input.requestedBy : "—";
  };

  const rows =
    runs
      .map((run) => {
        const name = proposalFromRun(run)?.projectName ?? "—";
        return `<tr>
        <td><a href="/runs/${escapeHtml(run.id)}"><code>${escapeHtml(run.id)}</code></a></td>
        <td>${escapeHtml(name)}</td>
        <td class="small">${escapeHtml(requester(run))}</td>
        <td>${statusTag(run)}</td>
        <td class="small">${decisionCell(run)}</td>
        <td class="small muted">${money(run.spentUsd)}</td>
        <td class="small muted">${escapeHtml(new Date(run.createdAt).toISOString())}</td>
      </tr>`;
      })
      .join("") ||
    `<tr><td colspan="7" class="muted">No builds yet.</td></tr>`;

  const banner = demoMode
    ? `<div class="panel"><strong>Demo mode.</strong> No Anthropic credentials found, so builds
       replay recorded fixtures instead of calling a model. The pipeline, the test-gate and the
       approval flow are real; only the model responses are canned. Set
       <code>ANTHROPIC_API_KEY</code> to run it live.</div>`
    : "";

  return page(
    "Andromeda — builds",
    `${banner}
    <h1>Builds</h1>
    <p class="muted small">Every build stops for a human before anything is written anywhere.</p>

    <div class="panel">
      <h2 style="margin-top:0">New build</h2>
      <form method="post" action="/runs">
        <textarea name="intent" required placeholder="Describe the project to build."></textarea>
        <input name="requestedBy" required placeholder="you@example.com" />
        <button class="primary" type="submit">Start build</button>
      </form>
    </div>

    <table>
      <thead><tr><th>Run</th><th>Project</th><th>Requested by</th><th>Status</th><th>Decision</th><th>Spend</th><th>Started</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`,
  );
}

function featureSection(builds: FeatureBuild[]): string {
  if (builds.length === 0) return `<p class="muted">No generated features.</p>`;
  return builds
    .map((build) => {
      const verdict = build.passed
        ? `<span class="good">passed</span> after ${build.attempts.length} attempt(s)`
        : `<span class="bad">never passed</span> in ${build.attempts.length} attempt(s)`;
      const files = build.files
        .map(
          (file) => `<details><summary>${escapeHtml(file.path)}</summary>
            <pre>${escapeHtml(file.contents)}</pre></details>`,
        )
        .join("");
      return `<div class="panel">
        <strong><code>${escapeHtml(build.featureId)}</code></strong> — ${verdict}
        ${files}
        <details><summary>test output</summary><pre>${escapeHtml(build.testOutput)}</pre></details>
      </div>`;
    })
    .join("");
}

export function reviewPage(
  record: RunRecord,
  approval: ApprovalRequest | null,
  events: AuditEvent[],
): string {
  const proposal = proposalFromRun(record);

  if (!proposal) {
    return page(
      `Andromeda — ${record.id}`,
      `<h1>Build ${escapeHtml(record.id)}</h1>
       <p>${statusTag(record)}</p>
       ${record.error ? `<pre>${escapeHtml(record.error.message)}</pre>` : ""}
       ${auditSection(events)}
       <p><a href="/">Back to builds</a></p>`,
    );
  }

  const risk = proposal.risk;
  const factors = risk.factors.map((f) => `<li>${escapeHtml(f)}</li>`).join("");
  const files = proposal.files
    .map(
      (file) => `<details><summary>${escapeHtml(file.path)}</summary>
        <pre>${escapeHtml(file.contents)}</pre></details>`,
    )
    .join("");

  const decision =
    record.status === "suspended" && approval?.status === "pending"
      ? `<div class="panel">
          <h2 style="margin-top:0">Your decision</h2>
          <p class="small muted">Approving writes the repository to the delivery target. Nothing
             has been written yet.</p>
          <form method="post" action="/runs/${escapeHtml(record.id)}/decision">
            <input name="decidedBy" required placeholder="you@example.com" />
            <input name="note" placeholder="Note (optional)" style="flex:1" />
            <button class="primary" name="status" value="approved" type="submit">Approve</button>
            <button class="danger" name="status" value="rejected" type="submit">Reject</button>
          </form>
        </div>`
      : approval
        ? `<div class="panel small">Decision: <strong>${escapeHtml(approval.status)}</strong>
           ${approval.decidedBy ? `by ${escapeHtml(approval.decidedBy)}` : ""}
           ${approval.note ? `— ${escapeHtml(approval.note)}` : ""}</div>`
        : "";

  const gateNotice = proposal.testsGreen
    ? ""
    : `<div class="panel"><strong class="bad">Blocked by the test-gate.</strong>
       One or more generated features never passed their own tests, so this build was never
       offered for approval. The code and the failing output are below.</div>`;

  return page(
    `Andromeda — ${proposal.projectName}`,
    `<h1>${escapeHtml(proposal.projectName)}</h1>
    <p>${statusTag(record)} <span class="muted small">· run <code>${escapeHtml(record.id)}</code>
       · ${money(record.spentUsd)} spent · template
       <code>${escapeHtml(proposal.templateId)}@${escapeHtml(proposal.templateVersion)}</code></span></p>
    <p>${escapeHtml(proposal.spec.summary)}</p>

    ${gateNotice}

    <div class="panel">
      <h2 style="margin-top:0">Risk ${risk.score}/100
        <span class="bar"><span style="width:${Math.min(100, risk.score)}%"></span></span></h2>
      <ul class="small">${factors}</ul>
      <p class="small muted">Advisory only. A low score still requires your approval.</p>
    </div>

    ${spendSection(events)}

    ${decision}

    <h2>Test-gated features</h2>
    ${featureSection(proposal.featureBuilds)}

    <h2>Specification</h2>
    <details><summary>project.yaml (compiled in ${proposal.specAttempts} attempt(s))</summary>
      <pre>${escapeHtml(JSON.stringify(proposal.spec, null, 2))}</pre></details>

    <h2>Files (${proposal.files.length})</h2>
    ${files}

    ${auditSection(events)}

    <p><a href="/">Back to builds</a></p>`,
  );
}

/**
 * Where the money went, from the `llm.call` audit events the pipeline records
 * for every completion — the per-purpose, per-model account an operator needs
 * before billing anyone, without any schema beyond the audit log.
 */
function spendSection(events: AuditEvent[]): string {
  const calls = events.filter((event) => event.kind === "llm.call");
  if (calls.length === 0) return "";

  const byPurpose = new Map<string, { calls: number; usd: number }>();
  for (const event of calls) {
    const purpose = typeof event.data.purpose === "string" ? event.data.purpose : "(unknown)";
    const model = typeof event.data.model === "string" ? event.data.model : "(unknown)";
    const usd = typeof event.data.costUsd === "number" ? event.data.costUsd : 0;
    const key = `${purpose} · ${model}`;
    const row = byPurpose.get(key) ?? { calls: 0, usd: 0 };
    row.calls += 1;
    row.usd += usd;
    byPurpose.set(key, row);
  }

  const rows = [...byPurpose.entries()]
    .sort((a, b) => b[1].usd - a[1].usd)
    .map(
      ([key, row]) => `<tr>
        <td class="small"><code>${escapeHtml(key)}</code></td>
        <td class="small muted">${row.calls}</td>
        <td class="small">${money(row.usd)}</td>
      </tr>`,
    )
    .join("");

  return `<div class="panel">
    <h2 style="margin-top:0">Spend by purpose</h2>
    <table>
      <thead><tr><th>Purpose · model</th><th>Calls</th><th>Cost</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>`;
}

function auditSection(events: AuditEvent[]): string {
  const rows = events
    .map(
      (event) => `<tr>
        <td class="small muted">${escapeHtml(new Date(event.at).toISOString())}</td>
        <td class="small"><code>${escapeHtml(event.kind)}</code></td>
        <td class="small">${escapeHtml(event.summary)}</td>
      </tr>`,
    )
    .join("");
  return `<h2>Audit trail (${events.length})</h2>
    <details><summary>every step, model call and sandbox run</summary>
      <table><tbody>${rows}</tbody></table></details>`;
}

export function errorPage(message: string, status: number): string {
  return page(
    "Andromeda — error",
    `<h1>${status}</h1><p>${escapeHtml(message)}</p><p><a href="/">Back to builds</a></p>`,
  );
}
