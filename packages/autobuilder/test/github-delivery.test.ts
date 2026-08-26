import { test } from "node:test";
import assert from "node:assert/strict";

import { GitHubPullRequestDelivery, githubDeliveryFromEnv } from "../src/pr/github.ts";

interface Recorded {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

/** Scripted GitHub API: answers each endpoint and records every request. */
function fakeGitHub(overrides: Record<string, { status: number; body: unknown }> = {}) {
  const requests: Recorded[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = value;
    });
    requests.push({
      method,
      url,
      headers,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });
    const path = new URL(url).pathname;
    const key = `${method} ${path}`;
    const scripted =
      overrides[key] ??
      {
        "GET /repos/acme/site": { status: 200, body: { default_branch: "main" } },
        "GET /repos/acme/site/git/ref/heads%2Fmain": {
          status: 200,
          body: { object: { sha: "base-sha" } },
        },
        "POST /repos/acme/site/git/trees": { status: 201, body: { sha: "tree-sha" } },
        "POST /repos/acme/site/git/commits": { status: 201, body: { sha: "commit-sha" } },
        "POST /repos/acme/site/git/refs": { status: 201, body: {} },
        "POST /repos/acme/site/pulls": {
          status: 201,
          body: { html_url: "https://github.com/acme/site/pull/7" },
        },
      }[key];
    if (!scripted) return new Response(`unexpected call: ${key}`, { status: 500 });
    return new Response(JSON.stringify(scripted.body), { status: scripted.status });
  }) as typeof fetch;
  return { fetchImpl, requests };
}

const delivery = (fetchImpl: typeof fetch, options: Record<string, unknown> = {}) =>
  new GitHubPullRequestDelivery({ owner: "acme", repo: "site", token: "tkn", fetchImpl, ...options });

const request = {
  projectName: "link-shortener",
  approvedBy: "renee@example.com",
  files: [
    { path: "package.json", contents: "{}\n" },
    { path: "src/index.ts", contents: "export {};\n" },
  ],
};

test("delivers as branch + draft pull request on top of the default branch", async () => {
  const { fetchImpl, requests } = fakeGitHub();
  const receipt = await delivery(fetchImpl).deliver(request);

  assert.equal(receipt.target, "github-pull-request");
  assert.equal(receipt.location, "https://github.com/acme/site/pull/7");
  assert.equal(receipt.fileCount, 2);

  const [, , trees, commits, refs, pulls] = requests;
  assert.deepEqual(trees?.body, {
    base_tree: "base-sha",
    tree: [
      { path: "package.json", mode: "100644", type: "blob", content: "{}\n" },
      { path: "src/index.ts", mode: "100644", type: "blob", content: "export {};\n" },
    ],
  });
  assert.deepEqual(commits?.body, {
    message: "Add link-shortener (approved by renee@example.com)",
    tree: "tree-sha",
    parents: ["base-sha"],
  });
  assert.deepEqual(refs?.body, { ref: "refs/heads/andromeda/link-shortener", sha: "commit-sha" });
  const pr = pulls?.body as { head: string; base: string; draft: boolean; body: string };
  assert.equal(pr.head, "andromeda/link-shortener");
  assert.equal(pr.base, "main");
  assert.equal(pr.draft, true);
  assert.match(pr.body, /approved for delivery by renee@example.com/);
});

test("a configured base branch skips the default-branch lookup", async () => {
  const { fetchImpl, requests } = fakeGitHub({
    "GET /repos/acme/site/git/ref/heads%2Freleases": {
      status: 200,
      body: { object: { sha: "base-sha" } },
    },
  });
  await delivery(fetchImpl, { baseBranch: "releases" }).deliver(request);
  assert.ok(!requests.some((r) => r.method === "GET" && r.url.endsWith("/repos/acme/site")));
  const pulls = requests.find((r) => r.url.endsWith("/pulls"));
  assert.equal((pulls?.body as { base: string }).base, "releases");
});

test("a pathPrefix nests every delivered file without allowing escapes", async () => {
  const { fetchImpl, requests } = fakeGitHub();
  await delivery(fetchImpl, { pathPrefix: "apps/generated" }).deliver(request);
  const trees = requests.find((r) => r.url.endsWith("/git/trees"));
  const tree = (trees?.body as { tree: Array<{ path: string }> }).tree;
  assert.deepEqual(
    tree.map((t) => t.path),
    ["apps/generated/package.json", "apps/generated/src/index.ts"],
  );

  assert.throws(
    () => delivery(fetchImpl, { pathPrefix: "../outside" }),
    /unsafe pathPrefix/,
  );
});

test("path traversal and absolute paths are refused before any call is made", async () => {
  for (const path of ["../evil", "/etc/passwd", "a/../../b", "a\\b"]) {
    const { fetchImpl, requests } = fakeGitHub();
    await assert.rejects(
      delivery(fetchImpl).deliver({ ...request, files: [{ path, contents: "x" }] }),
      /unsafe path/,
    );
    assert.equal(requests.length, 0);
  }
});

test("an empty delivery is refused", async () => {
  const { fetchImpl } = fakeGitHub();
  await assert.rejects(
    delivery(fetchImpl).deliver({ ...request, files: [] }),
    /no files/,
  );
});

test("an existing branch fails loudly instead of overwriting history", async () => {
  const { fetchImpl } = fakeGitHub({
    "POST /repos/acme/site/git/refs": {
      status: 422,
      body: { message: "Reference already exists" },
    },
  });
  await assert.rejects(
    delivery(fetchImpl).deliver(request),
    (err: Error) => /422/.test(err.message) && /Reference already exists/.test(err.message),
  );
});

test("a repo plan that rejects draft PRs falls back to a regular PR", async () => {
  // Private repositories on GitHub Free return 422 for draft:true. The branch
  // already exists by then, so the delivery must complete rather than strand it.
  let calls = 0;
  const { fetchImpl, requests } = fakeGitHub();
  const wrapped = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).endsWith("/pulls") && ++calls === 1) {
      requests.push({ method: "POST", url: String(input), headers: {}, body: JSON.parse(String(init?.body)) });
      return new Response(
        JSON.stringify({ message: "Draft pull requests are not supported in this repository." }),
        { status: 422 },
      );
    }
    return fetchImpl(input, init);
  }) as typeof fetch;

  const receipt = await delivery(wrapped).deliver(request);
  assert.equal(receipt.location, "https://github.com/acme/site/pull/7");
  const pulls = requests.filter((r) => r.url.endsWith("/pulls"));
  assert.equal(pulls.length, 2);
  assert.equal((pulls[0]?.body as { draft?: boolean }).draft, true);
  assert.equal((pulls[1]?.body as { draft?: boolean }).draft, undefined);
});

test("a 422 that is not about drafts is not retried", async () => {
  const { fetchImpl } = fakeGitHub({
    "POST /repos/acme/site/pulls": {
      status: 422,
      body: { message: "Validation Failed: base does not exist" },
    },
  });
  await assert.rejects(delivery(fetchImpl).deliver(request), /base does not exist/);
});

test("api errors never leak the token", async () => {
  const { fetchImpl } = fakeGitHub({
    "POST /repos/acme/site/git/trees": { status: 500, body: { message: "boom" } },
  });
  await assert.rejects(delivery(fetchImpl).deliver(request), (err: Error) => {
    assert.ok(!err.message.includes("tkn"));
    return true;
  });
});

test("every request authenticates with the token and GitHub's api version", async () => {
  const { fetchImpl, requests } = fakeGitHub();
  await delivery(fetchImpl).deliver(request);
  for (const r of requests) {
    assert.equal(r.headers.authorization, "Bearer tkn");
    assert.equal(r.headers["x-github-api-version"], "2022-11-28");
  }
});

test("githubDeliveryFromEnv builds from owner/repo + token, or stays local", () => {
  assert.equal(githubDeliveryFromEnv({}), null);
  assert.equal(githubDeliveryFromEnv({ GITHUB_TOKEN: "t" }), null);
  assert.equal(githubDeliveryFromEnv({ ANDROMEDA_DELIVERY_REPO: "acme/site" }), null);

  const built = githubDeliveryFromEnv({ ANDROMEDA_DELIVERY_REPO: "acme/site", GITHUB_TOKEN: "t" });
  assert.equal(built?.name, "github-pull-request");

  assert.throws(
    () => githubDeliveryFromEnv({ ANDROMEDA_DELIVERY_REPO: "not-a-repo", GITHUB_TOKEN: "t" }),
    /owner\/repo/,
  );
  assert.throws(
    () => githubDeliveryFromEnv({ ANDROMEDA_DELIVERY_REPO: "a/b/c", GITHUB_TOKEN: "t" }),
    /owner\/repo/,
  );
});
