// The pull request preview action (action/): its definition, the logic in action/preview.sh and
// whole publish and delete runs with a fake CLI and a fake gh, so nothing reaches GitHub or
// Portifact.
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse } from "yaml";

const ROOT = join(import.meta.dirname, "..");
const ACTION = join(ROOT, "action");
const SCRIPT = join(ACTION, "preview.sh");
const SECRET = `pfst_${"A".repeat(43)}`;
const SHA = "0123456789abcdef0123456789abcdef01234567";

interface Step {
  name?: string;
  id?: string;
  if?: string;
  uses?: string;
  run?: string;
  shell?: string;
  env?: Record<string, string>;
}

interface Run {
  status: number;
  stdout: string;
  stderr: string;
}

/** Calls one function of preview.sh with arguments and an environment, in a clean bash. */
function call(fn: string, args: string[], env: Record<string, string> = {}): Run {
  const result = spawnSync(
    "bash",
    ["-c", 'source "$1"; shift; "$@"', "bash", SCRIPT, fn, ...args],
    {
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...env },
    },
  );
  return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

/** Runs a subcommand of preview.sh as the action does. */
function main(command: string, env: Record<string, string>): Run {
  const result = spawnSync("bash", [SCRIPT, command], {
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...env },
  });
  return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

function readAction() {
  return parse(readFileSync(join(ACTION, "action.yml"), "utf8")) as {
    inputs: Record<string, { required?: boolean; default?: string }>;
    outputs: Record<string, { value: string }>;
    runs: { using: string; steps: Step[] };
  };
}

/** The workflow examples in docs/github-actions.md, parsed. */
function docWorkflows() {
  const doc = readFileSync(join(ROOT, "docs", "github-actions.md"), "utf8");
  return [...doc.matchAll(/```yaml\n([\s\S]*?)```/g)].map(
    (match) => parse(match[1] ?? "") as { jobs: Record<string, { steps: Step[] }> },
  );
}

function expectSafeSteps(steps: Step[]) {
  for (const step of steps) {
    // Expressions belong in env, where the runner passes them as data; inside a script they
    // become code, so a pull request title could run commands.
    if (step.run !== undefined) expect(step.run, step.name).not.toContain("${{");
    // The docs name this action's own ref as a placeholder for the reader's release.
    if (step.uses?.startsWith("leynier/portifact/action@<")) continue;
    if (step.uses !== undefined && !step.uses.startsWith("./")) {
      expect(step.uses, step.name).toMatch(/^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/);
    }
  }
}

describe("action.yml", () => {
  it("is a composite action with the documented inputs and outputs", () => {
    const action = readAction();
    expect(action.runs.using).toBe("composite");
    expect(Object.keys(action.inputs).sort()).toEqual(
      [
        "cli-version",
        "comment",
        "delete-on-close",
        "fail-without-token",
        "github-token",
        "key",
        "name",
        "path",
        "token",
        "workspace",
      ].sort(),
    );
    expect(action.inputs.path?.required).toBe(true);
    // A token or, for GitHub Actions OIDC (decision 0024), a workspace.
    expect(action.inputs.token?.required).toBe(false);
    expect(action.inputs.token?.default).toBe("");
    expect(action.inputs.workspace?.required).toBe(false);
    expect(action.inputs.workspace?.default).toBe("");
    expect(action.inputs.comment?.default).toBe("true");
    expect(action.inputs["delete-on-close"]?.default).toBe("true");
    expect(action.inputs["fail-without-token"]?.default).toBe("false");
    expect(Object.keys(action.outputs).sort()).toEqual(["artifact-id", "url", "version"]);
    for (const output of Object.values(action.outputs)) {
      expect(output.value).toMatch(/^\$\{\{ steps\.publish\.outputs\.[\w-]+ \}\}$/);
    }
  });

  it("names the OIDC workspace to the CLI only in the steps that call it", () => {
    for (const step of readAction().runs.steps) {
      const env = Object.entries(step.env ?? {});
      const withWorkspace = env.filter(([, value]) => value.includes("inputs.workspace"));
      if (step.id === "publish" || step.name === "Delete the preview") {
        expect(withWorkspace).toEqual([["PORTIFACT_GITHUB_OIDC", "${{ inputs.workspace }}"]]);
      } else if (step.id === "plan") {
        expect(withWorkspace).toEqual([["PF_WORKSPACE", "${{ inputs.workspace }}"]]);
      } else {
        expect(withWorkspace).toEqual([]);
      }
    }
  });

  it("puts no expression in a script and pins every action it uses", () => {
    expectSafeSteps(readAction().runs.steps);
  });

  it("gives the token only to the steps that call the CLI, through the environment", () => {
    for (const step of readAction().runs.steps) {
      const env = Object.entries(step.env ?? {});
      const withToken = env.filter(([, value]) => value.includes("inputs.token"));
      if (step.id === "publish" || step.name === "Delete the preview") {
        expect(withToken).toEqual([["PORTIFACT_TOKEN", "${{ inputs.token }}"]]);
      } else if (step.id === "plan") {
        // The plan only learns whether a token is there.
        expect(withToken).toEqual([["PF_TOKEN_SET", "${{ inputs.token != '' && 'yes' || '' }}"]]);
      } else {
        expect(withToken).toEqual([]);
      }
    }
  });

  it("documents the OIDC workflow with id-token: write and the workspace input, never a token", () => {
    const doc = readFileSync(join(ROOT, "docs", "github-actions.md"), "utf8");
    const workflows = [...doc.matchAll(/```yaml\n([\s\S]*?)```/g)].map(
      (match) =>
        parse(match[1] ?? "") as {
          permissions?: Record<string, string>;
          jobs: Record<string, { steps: Step[] & { with?: Record<string, string> }[] }>;
        },
    );
    const oidc = workflows.filter((workflow) => workflow.permissions?.["id-token"] === "write");
    expect(oidc).toHaveLength(1);
    const steps = Object.values(oidc[0]?.jobs ?? {}).flatMap((job) => job.steps);
    const action = steps.find((step) => step.uses?.startsWith("leynier/portifact/action@")) as
      | (Step & { with?: Record<string, string> })
      | undefined;
    expect(action?.with?.workspace).toBeTruthy();
    expect(action?.with?.token).toBeUndefined();
  });

  it("documents workflows that follow the same rules and never use pull_request_target", () => {
    const workflows = docWorkflows();
    expect(workflows.length).toBeGreaterThan(0);
    for (const workflow of workflows) {
      expect(JSON.stringify(workflow)).not.toContain("pull_request_target");
      for (const job of Object.values(workflow.jobs)) expectSafeSteps(job.steps);
    }
  });
});

describe("deciding what an event does", () => {
  const decide = (event: string, action: string, token = "yes", del = "true", fail = "false") =>
    call("pf_decide", [event, action, token, del, fail]);

  it("publishes on opened, synchronize and reopened and deletes on closed", () => {
    for (const action of ["opened", "synchronize", "reopened"]) {
      expect(decide("pull_request", action).stdout).toBe("publish");
    }
    expect(decide("pull_request", "closed").stdout).toBe("delete");
    expect(decide("pull_request", "closed", "yes", "false").stdout).toBe("skip");
    expect(decide("pull_request", "labeled").stdout).toBe("skip");
  });

  it("skips with a warning without a token, or fails when asked to", () => {
    const skipped = decide("pull_request", "opened", "");
    expect(skipped.status).toBe(0);
    expect(skipped.stdout).toBe("skip");
    expect(skipped.stderr).toMatch(/^::warning::No Portifact token.*forks get no secrets/);
    const failed = decide("pull_request", "closed", "", "true", "true");
    expect(failed.status).toBe(1);
    expect(failed.stderr).toMatch(/^::error::No Portifact token/);
    // An event that does nothing needs no token.
    expect(decide("pull_request", "edited", "").stderr).toBe("");
  });

  it("tells an OIDC run without an ID token what to grant", () => {
    const skipped = call("pf_decide", ["pull_request", "opened", "", "true", "false", "oidc"]);
    expect(skipped.stdout).toBe("skip");
    expect(skipped.stderr).toMatch(/^::warning::No GitHub ID token.*id-token: write/);
  });

  it("refuses pull_request_target and other events", () => {
    const target = decide("pull_request_target", "opened");
    expect(target.status).toBe(1);
    expect(target.stderr).toContain("refuses pull_request_target");
    expect(decide("push", "").status).toBe(1);
  });

  it("refuses a boolean input that is not true or false", () => {
    expect(decide("pull_request", "closed", "yes", "yes").status).toBe(1);
  });
});

describe("the key and the name", () => {
  it("defaults the key to pr-<number> and checks it like the API", () => {
    expect(call("pf_key", ["", "42"]).stdout).toBe("pr-42");
    expect(call("pf_key", ["docs/preview-1", "42"]).stdout).toBe("docs/preview-1");
    for (const bad of ["-x", "a b", "a;rm", "a".repeat(129), "é"]) {
      expect(call("pf_key", [bad, "42"]).status, bad).toBe(1);
    }
    expect(call("pf_key", ["", ""]).status).toBe(1);
    expect(call("pf_key", ["", "1; echo"]).status).toBe(1);
  });

  it("keeps an OIDC run's key in its repository's namespace", () => {
    expect(call("pf_oidc_prefix", ["123"]).stdout).toBe("gh-123/");
    expect(call("pf_oidc_prefix", [""]).status).toBe(1);
    expect(call("pf_oidc_prefix", ["12; id"]).status).toBe(1);
    expect(call("pf_key", ["", "42", "gh-123/"]).stdout).toBe("gh-123/pr-42");
    expect(call("pf_key", ["gh-123/docs", "42", "gh-123/"]).stdout).toBe("gh-123/docs");
    expect(call("pf_key", ["pr-42", "42", "gh-123/"]).status).toBe(1);
    expect(call("pf_key", ["gh-1234/pr-42", "42", "gh-123/"]).status).toBe(1);
  });

  it("takes a workspace slug and nothing else", () => {
    expect(call("pf_workspace", ["acme"]).stdout).toBe("acme");
    expect(call("pf_workspace", [""]).stdout).toBe("");
    for (const bad of ["Acme", "a b", "a;id", "-a"]) {
      expect(call("pf_workspace", [bad]).status, bad).toBe(1);
    }
  });

  it("names the artifact after the pull request, without control characters, within 200 bytes", () => {
    expect(call("pf_name", ["", "Fix the login", "7"]).stdout).toBe("PR #7: Fix the login");
    expect(call("pf_name", ["", "", "7"]).stdout).toBe("PR #7");
    expect(call("pf_name", ["Docs", "ignored", "7"]).stdout).toBe("Docs");
    expect(call("pf_name", ["", "a\nb\tc\u001b[31m", "7"]).stdout).toBe("PR #7: abc[31m");
    const long = call("pf_name", ["", "é".repeat(150), "7"]).stdout;
    expect(Buffer.byteLength(long)).toBeLessThanOrEqual(200);
    expect(long).toBe(`PR #7: ${"é".repeat(96)}`);
    expect(call("pf_name", ["", "x", ""]).status).toBe(1);
  });
});

describe("the CLI version", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pf-action-version-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("reads the release from the CLI manifest next to the action", () => {
    const version = call("pf_cli_version", ["", ACTION]).stdout;
    const manifest = JSON.parse(readFileSync(join(ROOT, "packages/cli/package.json"), "utf8"));
    expect(version).toBe(manifest.version);
  });

  it("takes an explicit version or latest, and refuses anything else", () => {
    expect(call("pf_cli_version", ["v1.2.3", dir]).stdout).toBe("1.2.3");
    const latest = call("pf_cli_version", ["latest", dir]);
    expect([latest.status, latest.stdout]).toEqual([0, ""]);
    expect(call("pf_cli_version", ["1.2", dir]).status).toBe(1);
    expect(call("pf_cli_version", ["1.2.3; curl", dir]).status).toBe(1);
    expect(call("pf_cli_version", ["", join(dir, "action")]).stderr).toContain("cli-version");
  });
});

describe("the comment", () => {
  it("escapes everything Markdown or HTML would act on", () => {
    const hostile = "[x](https://evil.example) <img src=x> @team `code` <!-- *_~#!|";
    const escaped = call("pf_md_text", [hostile]).stdout;
    expect(escaped).not.toMatch(/[<>@]|[^\\]`/);
    expect(escaped).not.toContain("](");
    expect(escaped).not.toContain("https:");
    expect(escaped).toContain("\\[x\\]\\(https&#58;//evil\\.example\\)");
    expect(escaped).toContain("&lt;img src=x&gt;");
    expect(call("pf_md_text", ["a\nb"]).stdout).toBe("ab");
    expect(call("pf_md_text", ["a\\b"]).stdout).toBe("a\\\\b");
  });

  it("links the preview with its key, version and commit after the marker", () => {
    const body = call("pf_comment_body", [
      "published",
      "pr-7",
      "https://abc.portifact.dev/",
      "3",
      SHA,
      `https://github.com/o/r/commit/${SHA}`,
    ]).stdout;
    expect(body.split("\n")[0]).toBe("<!-- portifact-preview:pr-7 -->");
    expect(body).toContain("[Open the preview](https://abc.portifact.dev/)");
    expect(body).toContain(`| pr\\-7 | 3 | [\`0123456\`](https://github.com/o/r/commit/${SHA}) |`);
  });

  it("refuses values that are not what the CLI and the event give", () => {
    const body = (url: string, version: string, commit = SHA) =>
      call("pf_comment_body", ["published", "pr-7", url, version, commit, "https://x/"]);
    expect(body("javascript:alert(1)", "3").status).toBe(1);
    expect(body("https://a.dev/) [evil](https://evil", "3").status).toBe(1);
    expect(body("https://a.dev/", "3 <b>").status).toBe(1);
    expect(body("https://a.dev/", "3", "not a sha").stdout).toContain("| unknown |");
    expect(call("pf_comment_body", ["removed", "pr 7"]).status).toBe(1);
  });

  it("says the preview was removed", () => {
    const body = call("pf_comment_body", ["removed", "pr-7"]).stdout;
    expect(body).toContain("The preview pr\\-7 was removed when the pull request closed.");
  });
});

describe("workflow commands", () => {
  it("escapes messages so they cannot start another command", () => {
    const run = call("pf_command", ["error", "a\n::add-mask::x 100%"]);
    expect(run.stderr).toBe("::error::a%0A::add-mask::x 100%25\n");
  });
});

/**
 * A fake gh that serves the pull request's comments from a file and records every call, and a
 * fake portifact that records its arguments and whether it saw the token, then answers like the
 * real CLI's --json output (covered against the real API in e2e/tests/service-tokens.spec.ts).
 */
function fakes(dir: string, comments: unknown[], cli: { publish?: string; delete?: string }) {
  writeFileSync(join(dir, "comments.json"), JSON.stringify(comments));
  writeFileSync(join(dir, "publish.json"), cli.publish ?? "");
  writeFileSync(join(dir, "delete.json"), cli.delete ?? "");
  const gh = join(dir, "gh");
  writeFileSync(
    gh,
    `#!/usr/bin/env bash
all="$*"; printf '%s\\n' "\${all//$'\\n'/\\\\n}" >>"${dir}/gh.log"
[ "\${GH_FAIL:-}" = "1" ] && exit 1
case "$*" in
  "api --paginate "*) cat "${dir}/comments.json" ;;
  *) printf '{}' ;;
esac
`,
  );
  const portifact = join(dir, "portifact");
  writeFileSync(
    portifact,
    `#!/usr/bin/env bash
printf '%s\\n' "$@" >"${dir}/cli-args"
[ "$PORTIFACT_TOKEN" = "${SECRET}" ] && echo token-seen >"${dir}/cli-token"
[ -n "\${PORTIFACT_GITHUB_OIDC:-}" ] && printf '%s' "$PORTIFACT_GITHUB_OIDC" >"${dir}/cli-oidc"
cat "${dir}/$1.json"
exit "\${CLI_EXIT:-0}"
`,
  );
  chmodSync(gh, 0o755);
  chmodSync(portifact, 0o755);
  writeFileSync(join(dir, "output"), "");
  writeFileSync(join(dir, "summary"), "");
  return {
    env: {
      PORTIFACT_GH: gh,
      PORTIFACT_BIN: portifact,
      PORTIFACT_TOKEN: SECRET,
      GITHUB_OUTPUT: join(dir, "output"),
      GITHUB_STEP_SUMMARY: join(dir, "summary"),
      GITHUB_REPOSITORY: "o/r",
      GITHUB_SERVER_URL: "https://github.com",
      PF_NUMBER: "7",
      PF_KEY: "pr-7",
    },
    ghCalls: () =>
      existsSync(join(dir, "gh.log"))
        ? readFileSync(join(dir, "gh.log"), "utf8").trim().split("\n")
        : [],
    cliArgs: () => readFileSync(join(dir, "cli-args"), "utf8").trim().split("\n"),
    sawToken: () => existsSync(join(dir, "cli-token")),
    oidcWorkspace: () =>
      existsSync(join(dir, "cli-oidc")) ? readFileSync(join(dir, "cli-oidc"), "utf8") : null,
    output: () => readFileSync(join(dir, "output"), "utf8"),
    summary: () => readFileSync(join(dir, "summary"), "utf8"),
  };
}

const PUBLISHED = JSON.stringify({
  artifactId: "abc123",
  versionId: "v_1",
  versionNumber: 2,
  url: "https://abc123.portifact.dev/",
  expiresAt: "2026-12-10T00:00:00.000Z",
  workspace: null,
});

const BOT_COMMENT = { id: 99, user: { type: "Bot" }, body: "<!-- portifact-preview:pr-7 -->\nold" };

describe("publish runs", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pf-action-run-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("publishes by key with the pull request's name, sets outputs and creates the comment", () => {
    const fake = fakes(dir, [], { publish: PUBLISHED });
    const run = main("publish", {
      ...fake.env,
      PF_PATH: "./dist",
      PF_TITLE: '--evil "$(touch pwned)" `id`',
      PF_SHA: SHA,
    });
    expect(run.status, run.stderr).toBe(0);
    expect(fake.cliArgs()).toEqual([
      "publish",
      "./dist",
      "--key=pr-7",
      '--name=PR #7: --evil "$(touch pwned)" `id`',
      "--json",
    ]);
    expect(existsSync(join(dir, "pwned"))).toBe(false);
    expect(fake.sawToken()).toBe(true);
    expect(fake.output()).toBe(
      "url=https://abc123.portifact.dev/\nartifact-id=abc123\nversion=2\n",
    );
    const calls = fake.ghCalls();
    expect(calls[0]).toBe("api --paginate repos/o/r/issues/7/comments?per_page=100");
    expect(calls[1]).toMatch(
      /^api --method POST repos\/o\/r\/issues\/7\/comments -f body=<!-- portifact-preview:pr-7 -->/,
    );
    expect(calls).toHaveLength(2);
    for (const text of [run.stdout, run.stderr, fake.output(), fake.summary(), calls.join("\n")]) {
      expect(text).not.toContain(SECRET);
    }
  });

  it("updates its own comment instead of adding one, ignoring people's comments with the marker", () => {
    const person = { id: 5, user: { type: "User" }, body: "<!-- portifact-preview:pr-7 -->" };
    const fake = fakes(dir, [person, BOT_COMMENT], { publish: PUBLISHED });
    const run = main("publish", { ...fake.env, PF_PATH: "dist", PF_SHA: SHA });
    expect(run.status, run.stderr).toBe(0);
    expect(fake.ghCalls()[1]).toMatch(
      /^api --method PATCH repos\/o\/r\/issues\/comments\/99 -f body=/,
    );
  });

  it("lets the CLI exchange the run's ID token when the workspace input is set and no token", () => {
    const fake = fakes(dir, [], { publish: PUBLISHED });
    const env: Record<string, string> = {
      ...fake.env,
      PORTIFACT_TOKEN: "",
      PORTIFACT_GITHUB_OIDC: "acme",
      PF_KEY: "gh-123/pr-7",
      PF_PATH: "dist",
      PF_SHA: SHA,
    };
    const run = main("publish", env);
    expect(run.status, run.stderr).toBe(0);
    expect(fake.cliArgs()).toContain("--key=gh-123/pr-7");
    expect(fake.sawToken()).toBe(false);
    expect(fake.oidcWorkspace()).toBe("acme");
  });

  it("leaves the comment out when comment is false", () => {
    const fake = fakes(dir, [], { publish: PUBLISHED });
    const run = main("publish", { ...fake.env, PF_PATH: "dist", PF_COMMENT: "false" });
    expect(run.status, run.stderr).toBe(0);
    expect(fake.ghCalls()).toEqual([]);
  });

  it("warns, without failing, when the comment cannot be written", () => {
    const fake = fakes(dir, [], { publish: PUBLISHED });
    const run = main("publish", { ...fake.env, PF_PATH: "dist", GH_FAIL: "1" });
    expect(run.status).toBe(0);
    expect(run.stderr).toContain("::warning::Could not read the pull request's comments");
  });

  it("fails with the CLI's message and exit code", () => {
    const error = JSON.stringify({ error: { code: "forbidden", message: "Not allowed.\n::x::" } });
    const fake = fakes(dir, [], { publish: error });
    const run = main("publish", { ...fake.env, PF_PATH: "dist", CLI_EXIT: "3" });
    expect(run.status).toBe(3);
    expect(run.stderr).toContain(
      "::error::portifact publish failed (exit 3): Not allowed.%0A::x::",
    );
    expect(fake.ghCalls()).toEqual([]);
  });

  it("refuses an answer it does not expect rather than writing it anywhere", () => {
    const odd = JSON.stringify({ artifactId: "abc", versionNumber: 1, url: "https://x.dev/\n" });
    const fake = fakes(dir, [], { publish: odd.replace("\\n", " evil=1") });
    const run = main("publish", { ...fake.env, PF_PATH: "dist" });
    expect(run.status).toBe(1);
    expect(fake.output()).toBe("");
  });

  it("needs the path input", () => {
    const fake = fakes(dir, [], { publish: PUBLISHED });
    expect(main("publish", { ...fake.env, PF_PATH: "" }).status).toBe(1);
  });
});

describe("delete runs", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pf-action-run-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("deletes by key and marks the comment removed", () => {
    const deleted = JSON.stringify({ key: "pr-7", artifactId: "abc123", deleted: true });
    const fake = fakes(dir, [BOT_COMMENT], { delete: deleted });
    const run = main("delete", fake.env);
    expect(run.status, run.stderr).toBe(0);
    expect(fake.cliArgs()).toEqual(["delete", "--key=pr-7", "--yes", "--json"]);
    expect(fake.sawToken()).toBe(true);
    expect(fake.ghCalls()[1]).toMatch(
      /^api --method PATCH repos\/o\/r\/issues\/comments\/99 -f body=.*/,
    );
    expect(fake.summary()).toContain("Deleted the Portifact preview `pr-7`.");
  });

  it("succeeds when no artifact has the key and adds no comment", () => {
    const fake = fakes(dir, [], { delete: JSON.stringify({ key: "pr-7", deleted: false }) });
    const run = main("delete", fake.env);
    expect(run.status, run.stderr).toBe(0);
    expect(fake.summary()).toContain("nothing to delete");
    expect(fake.ghCalls()).toEqual(["api --paginate repos/o/r/issues/7/comments?per_page=100"]);
  });
});

describe("plan runs", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pf-action-plan-"));
    writeFileSync(join(dir, "output"), "");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const plan = (env: Record<string, string>) =>
    main("plan", {
      GITHUB_EVENT_NAME: "pull_request",
      GITHUB_ACTION_PATH: ACTION,
      GITHUB_OUTPUT: join(dir, "output"),
      PF_NUMBER: "12",
      PF_TOKEN_SET: "yes",
      ...env,
    });

  it("writes the mode, the key and the CLI version", () => {
    const run = plan({ PF_ACTION: "synchronize", PF_CLI_VERSION: "0.9.1" });
    expect(run.status, run.stderr).toBe(0);
    expect(readFileSync(join(dir, "output"), "utf8")).toBe(
      "mode=publish\nkey=pr-12\ncli-version=0.9.1\n",
    );
  });

  it("writes only skip for a fork's pull request", () => {
    const run = plan({ PF_ACTION: "opened", PF_TOKEN_SET: "" });
    expect(run.status).toBe(0);
    expect(readFileSync(join(dir, "output"), "utf8")).toBe("mode=skip\n");
  });

  it("plans an OIDC run in the repository's namespace when the job can ask for an ID token", () => {
    const run = plan({
      PF_ACTION: "opened",
      PF_TOKEN_SET: "",
      PF_WORKSPACE: "acme",
      ACTIONS_ID_TOKEN_REQUEST_URL: "https://runner.example/id?api-version=2.0",
      GITHUB_REPOSITORY_ID: "123",
      PF_CLI_VERSION: "0.9.1",
    });
    expect(run.status, run.stderr).toBe(0);
    expect(readFileSync(join(dir, "output"), "utf8")).toBe(
      "mode=publish\nkey=gh-123/pr-12\ncli-version=0.9.1\n",
    );
  });

  it("skips an OIDC run that cannot ask for an ID token, as a fork's pull request", () => {
    const run = plan({ PF_ACTION: "opened", PF_TOKEN_SET: "", PF_WORKSPACE: "acme" });
    expect(run.status).toBe(0);
    expect(run.stderr).toContain("No GitHub ID token");
    expect(readFileSync(join(dir, "output"), "utf8")).toBe("mode=skip\n");
  });

  it("keeps the token in charge when both are set", () => {
    const run = plan({
      PF_ACTION: "opened",
      PF_WORKSPACE: "acme",
      ACTIONS_ID_TOKEN_REQUEST_URL: "https://runner.example/id",
      GITHUB_REPOSITORY_ID: "123",
      PF_CLI_VERSION: "0.9.1",
    });
    expect(run.status, run.stderr).toBe(0);
    expect(readFileSync(join(dir, "output"), "utf8")).toContain("key=pr-12\n");
  });

  it("refuses an unknown subcommand", () => {
    expect(main("nope", {}).status).toBe(1);
  });
});

describe("install runs", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pf-action-install-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  /** A local release with a fake binary for this machine, as install.sh downloads it. */
  function release(target: string, tamper = false) {
    const assets = join(dir, "release");
    const build = join(dir, "build");
    mkdirSync(assets, { recursive: true });
    mkdirSync(build, { recursive: true });
    writeFileSync(join(build, "portifact"), '#!/usr/bin/env bash\necho "9.9.9"\n');
    chmodSync(join(build, "portifact"), 0o755);
    const archive = `portifact-${target}.tar.gz`;
    spawnSync("tar", ["-czf", join(assets, archive), "-C", build, "portifact"]);
    const sum = spawnSync("sha256sum", [join(assets, archive)], { encoding: "utf8" }).stdout;
    const hash = tamper ? "0".repeat(64) : sum.split(" ")[0];
    writeFileSync(join(assets, "SHA256SUMS"), `${hash}  ${archive}\n`);
    return assets;
  }

  const linuxX64 = process.platform === "linux" && process.arch === "x64";

  it.runIf(linuxX64)("installs with the repository's installer into the runner's temp", () => {
    const env = {
      GITHUB_ACTION_PATH: ACTION,
      RUNNER_TEMP: dir,
      PORTIFACT_DOWNLOAD_URL: `file://${release("linux-x64")}`,
    };
    const run = main("install", env);
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toContain(`Installed portifact 9.9.9 to ${dir}/portifact-cli/portifact`);
    expect(run.stdout).not.toContain("Added");
    expect(call("pf_cli", ["--version"], { RUNNER_TEMP: dir }).stdout).toBe("9.9.9\n");
  });

  it.runIf(linuxX64)("stops when the download does not match its checksum", () => {
    const env = {
      GITHUB_ACTION_PATH: ACTION,
      RUNNER_TEMP: dir,
      PORTIFACT_DOWNLOAD_URL: `file://${release("linux-x64", true)}`,
    };
    const run = main("install", env);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("checksum mismatch");
    expect(existsSync(join(dir, "portifact-cli", "portifact"))).toBe(false);
  });
});
