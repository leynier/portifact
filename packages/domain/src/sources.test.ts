import { describe, expect, it } from "vitest";
import { checkSourceOrigin, isCredentialFreeRemote, stripRemoteCredentials } from "./sources.ts";

describe("isCredentialFreeRemote", () => {
  it("accepts remotes without credentials", () => {
    for (const remote of [
      "https://github.com/leynier/portifact.git",
      "ssh://git@github.com/leynier/portifact.git",
      "git+ssh://git@example.test/repo.git",
      "git@github.com:leynier/portifact.git",
      "/srv/git/portifact.git",
      "../portifact",
      "file:///srv/git/portifact.git",
    ]) {
      expect(isCredentialFreeRemote(remote), remote).toBe(true);
    }
  });

  it("refuses tokens, passwords, queries, fragments and unparsable URLs", () => {
    for (const remote of [
      "https://ghp_secret@github.com/leynier/portifact.git",
      "https://user:pass@github.com/leynier/portifact.git",
      "ssh://git:pass@github.com/leynier/portifact.git",
      "https://github.com/leynier/portifact.git?access_token=x",
      "https://github.com/leynier/portifact.git#token",
      "https://[bad/repo",
    ]) {
      expect(isCredentialFreeRemote(remote), remote).toBe(false);
    }
  });
});

describe("stripRemoteCredentials", () => {
  it("removes user names, passwords, queries and fragments from URLs", () => {
    expect(stripRemoteCredentials("https://x-access-token:ghs_1@github.com/o/r.git?a=1#f")).toBe(
      "https://github.com/o/r.git",
    );
    expect(stripRemoteCredentials("ssh://git:secret@example.test:2222/o/r.git")).toBe(
      "ssh://git@example.test:2222/o/r.git",
    );
  });

  it("keeps scp-like remotes and paths, and drops URLs it cannot parse", () => {
    expect(stripRemoteCredentials("git@github.com:o/r.git")).toBe("git@github.com:o/r.git");
    expect(stripRemoteCredentials("/srv/git/r.git")).toBe("/srv/git/r.git");
    expect(stripRemoteCredentials("https://[bad/repo")).toBeNull();
  });

  it("always gives a remote the server accepts", () => {
    for (const remote of [
      "https://a:b@h.test/r?x#y",
      "http://token@h.test/r",
      "ssh+git://u:p@h.test/r",
    ]) {
      const stripped = stripRemoteCredentials(remote);
      expect(stripped).not.toBeNull();
      expect(isCredentialFreeRemote(stripped as string), remote).toBe(true);
    }
  });
});

describe("checkSourceOrigin", () => {
  const origin = { commit: null, branch: "main", remote: null, dirty: false };

  it("needs source files", () => {
    expect(checkSourceOrigin(origin, 0)).toEqual({
      ok: false,
      code: "invalid_input",
      message: expect.stringContaining("source file"),
    });
    expect(checkSourceOrigin(origin, 1)).toEqual({ ok: true, value: origin });
  });

  it("refuses a remote with credentials", () => {
    const result = checkSourceOrigin({ ...origin, remote: "https://t@h.test/r" }, 2);
    expect(result.ok).toBe(false);
    expect(checkSourceOrigin({ ...origin, remote: "git@h.test:r" }, 2).ok).toBe(true);
  });
});
