import { describe, expect, it } from "vitest";
import { fetchMetadata, pageView, type ServedPage, utcDay } from "../src/views.ts";

const OWNER = "owner";

/** A top-level page load by an anonymous visitor, answered 200, on a plan with analytics. */
function page(overrides: Partial<ServedPage> = {}): ServedPage {
  return {
    method: "GET",
    fetchMode: "navigate",
    fetchDest: "document",
    fetchSite: "none",
    status: 200,
    isPage: true,
    viewerRedirect: false,
    visitorId: null,
    ownerId: OWNER,
    analytics: true,
    ...overrides,
  };
}

/** The viewer's frame load of the page: cross-site from app.portifact.com. */
const viewerFrame = (overrides: Partial<ServedPage> = {}) =>
  page({ fetchDest: "iframe", fetchSite: "cross-site", ...overrides });

describe("one visit is one view", () => {
  it("with the bar on: the redirect is not a view, the viewer's frame load is", () => {
    const redirect = page({ status: 303, viewerRedirect: true, isPage: true });
    expect(pageView(redirect)).toBeNull();
    // Even if the redirect were answered with a status that counts, the flag alone excludes it.
    expect(pageView({ ...redirect, status: 200 })).toBeNull();
    expect(pageView(viewerFrame())).toBe("anonymous");
  });

  it("with the bar off or the opt-out: the top-level document is the view", () => {
    expect(pageView(page())).toBe("anonymous");
  });

  it("a signed-in reader in the viewer is a signed-in view", () => {
    expect(pageView(viewerFrame({ visitorId: "reader" }))).toBe("signedIn");
  });

  it("another page of a site opened in the frame is another page view", () => {
    expect(pageView(viewerFrame({ fetchSite: "same-origin" }))).toBe("anonymous");
  });

  it("a reload that revalidates (304) and a ranged answer (206) count", () => {
    expect(pageView(page({ status: 304 }))).toBe("anonymous");
    expect(pageView(page({ status: 206 }))).toBe("anonymous");
  });
});

describe("what is never a view", () => {
  it.each([
    ["a subresource", { fetchMode: "no-cors", fetchDest: "image" }],
    ["a fetch from the page", { fetchMode: "cors", fetchDest: "empty" }],
    ["a file that is not a page opened in a tab", { isPage: false }],
    ["HEAD", { method: "HEAD" }],
    ["a client without fetch metadata", { fetchMode: null, fetchDest: null, fetchSite: null }],
    ["a frame a sibling artifact opened", { fetchDest: "iframe", fetchSite: "same-site" }],
    ["an embed that is not a frame", { fetchDest: "embed", fetchSite: "cross-site" }],
    ["a 404", { status: 404 }],
    ["a 429", { status: 429 }],
    ["a refusal sending to sign-in", { status: 302 }],
    ["an owner without analytics", { analytics: false }],
  ] satisfies [string, Partial<ServedPage>][])("%s", (_name, overrides) => {
    expect(pageView(page(overrides))).toBeNull();
  });

  it("the owner's own visit with a session, top-level or in the viewer", () => {
    expect(pageView(page({ visitorId: OWNER }))).toBeNull();
    expect(pageView(viewerFrame({ visitorId: OWNER }))).toBeNull();
  });

  it("an embed by another site of an embeddable public artifact is a view", () => {
    expect(pageView(page({ fetchDest: "iframe", fetchSite: "cross-site" }))).toBe("anonymous");
    expect(pageView(page({ fetchDest: "frame", fetchSite: "cross-site" }))).toBe("anonymous");
  });
});

describe("helpers", () => {
  it("reads the fetch metadata of a request", () => {
    const request = new Request("https://abc.portifact.dev/", {
      headers: {
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Dest": "iframe",
        "Sec-Fetch-Site": "cross-site",
      },
    });
    expect(fetchMetadata(request)).toEqual({
      method: "GET",
      fetchMode: "navigate",
      fetchDest: "iframe",
      fetchSite: "cross-site",
    });
  });

  it("rounds to the UTC day", () => {
    expect(utcDay(Date.UTC(2026, 10, 10, 23, 59, 59, 999))).toBe(Date.UTC(2026, 10, 10));
    expect(utcDay(Date.UTC(2026, 10, 11))).toBe(Date.UTC(2026, 10, 11));
  });
});
