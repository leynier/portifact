// Shapes of issue integrations (decision 0018): what an admin may paste and choose, what the
// owner side sends, and that nothing of a credential is in a view.
import { describe, expect, it } from "vitest";
import {
  CreateIssueFromThreadInput,
  GitHubRepo,
  INTEGRATION_LIMITS,
  IntegrationConnectionView,
  IntegrationCreate,
  IntegrationUpdate,
  IssueParts,
  LinearTeamId,
  ThreadIssueCreate,
  ThreadIssueView,
} from "./integrations.ts";
import { OutboxTopic, TombstoneMarker } from "./jobs.ts";

const TOKEN = "github_pat_11AAAAAAA0aaaaaaaaaaaa_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

describe("integration contracts", () => {
  it.each(["acme/site", "a/b.c_d-e", "A-1/x"])("accepts the repository %s", (repo) => {
    expect(GitHubRepo.safeParse(repo).success).toBe(true);
  });

  it.each(["acme", "acme/..", "acme/.", "-a/b", "a/b/c", "a b/c", `a/${"x".repeat(101)}`])(
    "refuses the repository %j",
    (repo) => {
      expect(GitHubRepo.safeParse(repo).success).toBe(false);
    },
  );

  it("accepts Linear team IDs as UUIDs only", () => {
    expect(LinearTeamId.safeParse("6f1d4c3a-1b2c-4d5e-8f90-0a1b2c3d4e5f").success).toBe(true);
    expect(LinearTeamId.safeParse("ENG").success).toBe(false);
  });

  it("takes a credential of printable characters within bounds, and bounded targets", () => {
    const base = { service: "github", label: "Repo", credential: TOKEN, targets: ["acme/site"] };
    expect(IntegrationCreate.safeParse(base).success).toBe(true);
    // Surrounding whitespace is trimmed; inner spaces, short or long values are refused.
    expect(IntegrationCreate.safeParse({ ...base, credential: ` ${TOKEN}\n` }).success).toBe(true);
    for (const credential of ["short", `${TOKEN} x`, "x".repeat(256)]) {
      expect(IntegrationCreate.safeParse({ ...base, credential }).success).toBe(false);
    }
    expect(IntegrationCreate.safeParse({ ...base, targets: [] }).success).toBe(false);
    expect(IntegrationCreate.safeParse({ ...base, targets: ["a/b", "A/B"] }).success).toBe(false);
    expect(
      IntegrationCreate.safeParse({
        ...base,
        targets: Array.from(
          { length: INTEGRATION_LIMITS.targetsPerConnection + 1 },
          (_, i) => `a/${i}`,
        ),
      }).success,
    ).toBe(false);
    expect(IntegrationCreate.safeParse({ ...base, host: "ghe.example.com" }).success).toBe(false);
    expect(IntegrationUpdate.safeParse({}).success).toBe(false);
  });

  it("defaults the parts to the link and the name, comment text off", () => {
    expect(IssueParts.parse({})).toEqual({
      link: true,
      artifactName: true,
      quote: false,
      message: false,
    });
    const body = ThreadIssueCreate.parse({
      connectionId: `ic_${"a".repeat(32)}`,
      target: "acme/site",
      title: "Fix",
    });
    expect(body.include).toEqual({ link: true, artifactName: true, quote: false, message: false });
    expect(
      CreateIssueFromThreadInput.safeParse({
        artifactId: "abcdefghijklmnop",
        threadId: "t",
        connectionId: "nope",
        target: "acme/site",
        title: "x",
      }).success,
    ).toBe(false);
  });

  it("has no credential field in a connection's view, and a URL only on an issue", () => {
    expect(Object.keys(IntegrationConnectionView.shape)).not.toContain("credential");
    expect(
      ThreadIssueView.safeParse({
        id: `ti_${"a".repeat(32)}`,
        service: "github",
        target: "acme/site",
        state: "created",
        key: "#1",
        url: "https://github.com/acme/site/issues/1",
        failure: null,
        own: false,
        createdAt: new Date(0).toISOString(),
      }).success,
    ).toBe(true);
  });

  it("knows the job topic and the tombstone kind", () => {
    expect(OutboxTopic.parse("thread_issue")).toBe("thread_issue");
    expect(
      TombstoneMarker.parse({ kind: "integration_connection", id: "ic_x", deletedAt: 1 }).kind,
    ).toBe("integration_connection");
  });
});
