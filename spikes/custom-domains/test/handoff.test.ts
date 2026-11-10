import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { httpsRedirect, type Resolved, topLevelAnswer } from "../src/delivery.ts";
import {
  callbackOrigin,
  frameAncestors,
  HANDOFF_TTL_MS,
  issueHandoff,
  readEntryUrl,
  redeemHandoff,
  viewerFrameOrigin,
  viewerFrameSrc,
} from "../src/handoff.ts";
import { APP_ORIGIN, CONTENT_DOMAIN, randomId, uid } from "./harness.ts";

const ID = "abcdefghij";
const DEV = `https://${ID}.${CONTENT_DOMAIN}`;
const CUSTOM = "docs.example.com";

describe("read entry and callback origin", () => {
  it("names the host only when the visitor started on a custom host", () => {
    expect(readEntryUrl(APP_ORIGIN, ID, "n", "artifact", `${ID}.${CONTENT_DOMAIN}`)).toBe(
      `${APP_ORIGIN}/read/${ID}?state=n`,
    );
    expect(readEntryUrl(APP_ORIGIN, ID, "n", "custom", CUSTOM)).toBe(
      `${APP_ORIGIN}/read/${ID}?state=n&host=${CUSTOM}`,
    );
  });

  it("chooses only between the artifact's two origins, never another host", () => {
    const base = { artifactId: ID, contentDomain: CONTENT_DOMAIN };
    expect(callbackOrigin({ ...base, requestedHost: null, activeHost: null })).toBe(DEV);
    expect(callbackOrigin({ ...base, requestedHost: null, activeHost: CUSTOM })).toBe(DEV);
    expect(callbackOrigin({ ...base, requestedHost: CUSTOM, activeHost: CUSTOM })).toBe(
      `https://${CUSTOM}`,
    );
    // Detached meanwhile, another artifact's domain, or anything typed into the URL: refused.
    expect(callbackOrigin({ ...base, requestedHost: CUSTOM, activeHost: null })).toBeNull();
    expect(
      callbackOrigin({ ...base, requestedHost: "evil.example", activeHost: CUSTOM }),
    ).toBeNull();
    expect(
      callbackOrigin({ ...base, requestedHost: `${ID}.${CONTENT_DOMAIN}`, activeHost: CUSTOM }),
    ).toBeNull();
  });
});

describe("handoff codes are bound to their host", () => {
  for (const kind of ["read", "review"] as const) {
    it(`${kind}: redeems once on the host it was sent to and nowhere else`, async () => {
      const artifactId = randomId();
      const userId = uid("usr");
      const custom = `${artifactId}-docs.example.com`;
      const code = await issueHandoff(env.GLOBAL, {
        kind,
        artifactId,
        origin: `https://${custom}`,
        userId,
        now: 1,
      });
      const at = { kind, code, artifactId, now: 2 };
      expect(
        await redeemHandoff(env.GLOBAL, { ...at, hostname: `${artifactId}.${CONTENT_DOMAIN}` }),
      ).toBeNull();
      expect(
        await redeemHandoff(env.GLOBAL, { ...at, artifactId: randomId(), hostname: custom }),
      ).toBeNull();
      expect(
        await redeemHandoff(env.GLOBAL, {
          ...at,
          kind: kind === "read" ? "review" : "read",
          hostname: custom,
        }),
      ).toBeNull();
      expect(await redeemHandoff(env.GLOBAL, { ...at, hostname: custom })).toEqual({ userId });
      expect(await redeemHandoff(env.GLOBAL, { ...at, hostname: custom })).toBeNull();
    });
  }

  it("refuses an expired code", async () => {
    const artifactId = randomId();
    const code = await issueHandoff(env.GLOBAL, {
      kind: "read",
      artifactId,
      origin: DEV,
      userId: "u",
      now: 1,
    });
    expect(
      await redeemHandoff(env.GLOBAL, {
        kind: "read",
        code,
        artifactId,
        hostname: `${ID}.${CONTENT_DOMAIN}`,
        now: 1 + HANDOFF_TTL_MS,
      }),
    ).toBeNull();
  });
});

describe("viewer frame source", () => {
  it("frames the custom host only for a visitor who may read the artifact", () => {
    const base = { artifactId: ID, contentDomain: CONTENT_DOMAIN };
    expect(viewerFrameOrigin({ ...base, visible: true, activeHost: CUSTOM })).toBe(
      `https://${CUSTOM}`,
    );
    expect(viewerFrameOrigin({ ...base, visible: true, activeHost: null })).toBe(DEV);
  });

  it("gives a missing, protected or unavailable artifact the same policy with or without a domain", () => {
    const base = { artifactId: ID, contentDomain: CONTENT_DOMAIN, visible: false };
    const withDomain = viewerFrameSrc(viewerFrameOrigin({ ...base, activeHost: CUSTOM }));
    const without = viewerFrameSrc(viewerFrameOrigin({ ...base, activeHost: null }));
    expect(withDomain).toBe(without);
    expect(withDomain).not.toContain(CUSTOM);
    expect(withDomain).toBe(`frame-src ${DEV} https://challenges.cloudflare.com`);
  });

  it("keeps frame-ancestors relative to the serving origin", () => {
    expect(frameAncestors(APP_ORIGIN, false)).toBe(`frame-ancestors 'self' ${APP_ORIGIN}`);
    expect(frameAncestors(APP_ORIGIN, true)).toBe("frame-ancestors *");
  });
});

function visit(url: string, headers: Record<string, string> = {}, method = "GET"): Request {
  return new Request(url, {
    method,
    headers: {
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Dest": "document",
      "Sec-Fetch-Site": "none",
      ...headers,
    },
  });
}

function resolved(via: "artifact" | "custom", bar: boolean, customHost: string | null): Resolved {
  return {
    region: "default",
    via,
    artifact: { id: ID, ownerId: "o", accessMode: "public", state: "active", bar, customHost },
  };
}

describe("top-level answers after authorization", () => {
  const page = { isPage: true, skipsViewer: false };

  it("sends old links to the custom host with their path and query when the bar is off", () => {
    expect(
      topLevelAnswer(visit(`${DEV}/guide/?x=1`), resolved("artifact", false, CUSTOM), page),
    ).toEqual({
      kind: "canonical",
      location: `https://${CUSTOM}/guide/?x=1`,
    });
  });

  it("lets the viewer win while the bar is on, on either host", () => {
    expect(topLevelAnswer(visit(`${DEV}/`), resolved("artifact", true, CUSTOM), page)).toEqual({
      kind: "viewer",
    });
    expect(
      topLevelAnswer(visit(`https://${CUSTOM}/`), resolved("custom", true, CUSTOM), page),
    ).toEqual({ kind: "viewer" });
    expect(
      topLevelAnswer(visit(`${DEV}/`), resolved("artifact", true, CUSTOM), {
        isPage: true,
        skipsViewer: true,
      }),
    ).toMatchObject({ kind: "canonical" });
  });

  it("serves frames, subresources, files, reserved paths, the custom host and artifacts without one", () => {
    const off = resolved("artifact", false, CUSTOM);
    expect(topLevelAnswer(visit(`${DEV}/`, { "Sec-Fetch-Dest": "iframe" }), off, page)).toEqual({
      kind: "serve",
    });
    expect(
      topLevelAnswer(
        visit(`${DEV}/app.js`, { "Sec-Fetch-Mode": "no-cors", "Sec-Fetch-Dest": "script" }),
        off,
        page,
      ),
    ).toEqual({ kind: "serve" });
    expect(topLevelAnswer(visit(`${DEV}/`, {}, "HEAD"), off, page)).toEqual({ kind: "serve" });
    expect(
      topLevelAnswer(visit(`${DEV}/report.pdf`), off, { isPage: false, skipsViewer: false }),
    ).toEqual({ kind: "serve" });
    expect(topLevelAnswer(visit(`${DEV}/__portifact/callback?code=x`), off, page)).toEqual({
      kind: "serve",
    });
    expect(topLevelAnswer(visit(`${DEV}/__PORTIFACT/raw`), off, page)).toEqual({ kind: "serve" });
    expect(
      topLevelAnswer(visit(`https://${CUSTOM}/`), resolved("custom", false, CUSTOM), page),
    ).toEqual({ kind: "serve" });
    expect(topLevelAnswer(visit(`${DEV}/`), resolved("artifact", false, null), page)).toEqual({
      kind: "serve",
    });
  });

  it("upgrades plain http on a custom host and sends no HSTS", () => {
    const response = httpsRedirect(new Request(`http://${CUSTOM}/a?b=1`));
    expect(response?.status).toBe(308);
    expect(response?.headers.get("Location")).toBe(`https://${CUSTOM}/a?b=1`);
    expect(response?.headers.has("Strict-Transport-Security")).toBe(false);
    expect(httpsRedirect(new Request(`https://${CUSTOM}/`))).toBeNull();
  });
});
