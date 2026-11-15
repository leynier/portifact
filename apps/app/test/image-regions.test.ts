// Image regions (decision 0028): a thread on an `img` may carry a rectangle of the image. The API
// and MCP accept it only while `IMAGE_REGIONS_ENABLED` is on, check the image is a file of the
// version, store its SHA-256 from the version and never the client's, count its bytes with the
// target's, and keep every other rule of creating a thread. History threads say whether the
// current version still has the same image bytes.
import { env } from "cloudflare:workers";
import { ReviewStart } from "@portifact/contracts";
import { describe, expect, it } from "vitest";
import { createHarness, type Harness, ORIGIN } from "./harness.ts";
import { api, apiToken, callTool, connect, mcpToken, type ToolResult } from "./mcp-helpers.ts";

const EVERY =
  "artifacts:read artifacts:write artifacts:share annotations:read annotations:write annotations:moderate offline_access";
const ON = { IMAGE_REGIONS_ENABLED: "true" };
const IMG = {
  schema: 1,
  path: "index.html",
  anchor: { kind: "element", selectors: ["#mock"], tagName: "img", fingerprint: "" },
};
const NOTE = {
  schema: 1,
  path: "index.html",
  anchor: { kind: "element", selectors: ["#note"], tagName: "p", fingerprint: "Note" },
};
const REGION = { x: 0.25, y: 0.5, width: 0.5, height: 0.25, image: { path: "images/mock.png" } };

interface View {
  id: string;
  current: boolean;
  region?: {
    x: number;
    y: number;
    width: number;
    height: number;
    image: { path: string; sha256: string };
    currentImage?: string;
  };
}

interface Client {
  h: Harness;
  userId: string;
  call(path: string, init?: RequestInit): Promise<Response>;
  tool(name: string, args: Record<string, unknown>): Promise<ToolResult>;
}

let emails = 0;

async function client(h: Harness, name: string): Promise<Client> {
  emails += 1;
  const email = `regions-${name}-${emails}@example.test`;
  const token = await apiToken(h, email, EVERY);
  const mcp = await connect(h, await mcpToken(h, email, EVERY));
  const call = (path: string, init?: RequestInit) => api(h, token, path, init);
  const me = await (await call("/api/v1/me")).json<{ userId: string }>();
  return { h, userId: me.userId, call, tool: (tool, args) => callTool(mcp, tool, args) };
}

async function sha256(bytes: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(bytes));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const PAGE = '<img id="mock" src="images/mock.png" alt="Mockup"><p id="note">Note</p>';

/** Publishes a site with a page, an image and a text file; with `artifactId`, a new version. */
async function publish(
  c: Client,
  image: string,
  update?: { artifactId: string; baseVersionId: string },
  extraImage?: string,
): Promise<{ artifactId: string; versionId: string }> {
  const files = [
    { path: "index.html", body: PAGE, contentType: "text/html" },
    { path: "images/mock.png", body: image, contentType: "image/png" },
    { path: "notes.txt", body: "notes", contentType: "text/plain" },
    ...(extraImage ? [{ path: extraImage, body: image, contentType: "image/png" }] : []),
  ];
  const manifest = await Promise.all(
    files.map(async (file) => ({
      path: file.path,
      sha256: await sha256(file.body),
      size: file.body.length,
      contentType: file.contentType,
    })),
  );
  const prepared = await c.call("/api/v1/publishes", {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
    body: JSON.stringify({
      type: "site",
      name: "Mockup",
      entrypoint: "index.html",
      files: manifest,
      ...(update ?? {}),
    }),
  });
  if (prepared.status !== 201) throw new Error(await prepared.text());
  const { uploadId, artifactId } = await prepared.json<{ uploadId: string; artifactId: string }>();
  for (const [i, file] of files.entries()) {
    const sha = manifest[i]?.sha256 as string;
    await env.ARTIFACTS.put(`objects/${c.userId}/${sha}`, file.body, { sha256: sha });
  }
  const commit = await c.call(`/api/v1/publishes/${uploadId}/commit`, { method: "POST" });
  expect(commit.status).toBe(200);
  const info = await (await c.call(`/api/v1/artifacts/${artifactId}`)).json<{
    currentVersionId: string;
  }>();
  return { artifactId, versionId: info.currentVersionId };
}

function post(body: unknown): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
    body: JSON.stringify(body),
  };
}

async function setup(options: { on?: boolean } = { on: true }) {
  const h = createHarness(options.on ? { env: ON } : {});
  const owner = await client(h, "owner");
  const published = await publish(owner, "png-bytes-1");
  const base = `/api/v1/artifacts/${published.artifactId}/annotations`;
  const mode = await owner.call(`${base}/mode`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode: "open" }),
  });
  expect(mode.status).toBe(200);
  return { h, owner, ...published, base };
}

const errorOf = async (response: Response) =>
  [response.status, (await response.json<{ error: { code: string } }>()).error.code] as const;

describe("image regions", () => {
  it("stores a region with the image's SHA-256 from the version and counts its bytes", async () => {
    const s = await setup();
    const created = await s.owner.call(
      `${s.base}/threads`,
      post({ versionId: s.versionId, target: IMG, region: REGION, body: "Too small" }),
    );
    expect(created.status).toBe(201);
    const thread = await created.json<View>();
    expect(thread.region).toEqual({
      ...REGION,
      image: { path: "images/mock.png", sha256: await sha256("png-bytes-1") },
    });
    expect(thread.region?.currentImage).toBeUndefined();

    const row = await env.DB.prepare(
      "select target, target_bytes, region from annotation_threads where id = ?",
    )
      .bind(thread.id)
      .first<{ target: string; target_bytes: number; region: string }>();
    const bytes = (text: string) => new TextEncoder().encode(text).length;
    expect(row?.target_bytes).toBe(bytes(row?.target ?? "") + bytes(row?.region ?? ""));

    const list = await (await s.owner.call(s.base)).json<{ threads: View[] }>();
    expect(list.threads[0]?.region?.image.path).toBe("images/mock.png");
    const markdown = await (await s.owner.call(`${s.base}/export?format=markdown`)).text();
    expect(markdown).toContain(
      "- Region: 25% to 75% across, 50% to 75% down, of `images/mock.png`",
    );
  });

  it("never takes a SHA-256 from the client", async () => {
    const s = await setup();
    const forged = { ...REGION, image: { path: "images/mock.png", sha256: "a".repeat(64) } };
    const response = await s.owner.call(
      `${s.base}/threads`,
      post({ versionId: s.versionId, target: IMG, region: forged, body: "x" }),
    );
    expect(await errorOf(response)).toEqual([400, "invalid_input"]);
  });

  it("refuses a region while switched off, through the API and MCP alike", async () => {
    const s = await setup({ on: false });
    const response = await s.owner.call(
      `${s.base}/threads`,
      post({ versionId: s.versionId, target: IMG, region: REGION, body: "x" }),
    );
    const body = await response.json<{ error: { code: string; message: string } }>();
    expect(response.status).toBe(400);
    expect(body.error).toMatchObject({
      code: "invalid_input",
      message: "Image regions are not available.",
    });
    const tool = await s.owner.tool("create_annotation", {
      artifactId: s.artifactId,
      versionId: s.versionId,
      target: IMG,
      region: REGION,
      body: "x",
      idempotencyKey: "regions-off-1",
    });
    expect(tool.isError).toBe(true);
    expect(tool.structuredContent).toEqual(body);
    // Without a region, nothing changes.
    const plain = await s.owner.call(
      `${s.base}/threads`,
      post({ versionId: s.versionId, target: IMG, body: "x" }),
    );
    expect(plain.status).toBe(201);
  });

  it("refuses a region on anything but an image file of the version", async () => {
    const s = await setup();
    const cases: [unknown, unknown][] = [
      [NOTE, REGION],
      [IMG, { ...REGION, image: { path: "images/gone.png" } }],
      [IMG, { ...REGION, image: { path: "notes.txt" } }],
      [IMG, { ...REGION, x: 0.75 }],
      [IMG, { ...REGION, width: 0.001 }],
      [IMG, { ...REGION, y: 0.12345 }],
    ];
    for (const [target, region] of cases) {
      const response = await s.owner.call(
        `${s.base}/threads`,
        post({ versionId: s.versionId, target, region, body: "x" }),
      );
      expect(await errorOf(response), JSON.stringify(region)).toEqual([400, "invalid_input"]);
    }
    const list = await (await s.owner.call(s.base)).json<{ threads: View[] }>();
    expect(list.threads).toHaveLength(0);
  });

  it("refuses a region a target pushes past the target limit", async () => {
    const s = await setup();
    // A target just under 8 KiB on its own (three bytes per character of its route): the region's
    // bytes take it over.
    const big = {
      ...IMG,
      anchor: { ...IMG.anchor, fingerprint: "" },
      route: `/${"€".repeat(1800)}`,
    };
    const selectors = Array.from({ length: 4 }, (_, i) => `#${"s".repeat(480)}${i}`);
    const target = { ...big, anchor: { ...big.anchor, selectors } };
    const bare = await s.owner.call(
      `${s.base}/threads`,
      post({ versionId: s.versionId, target, body: "x" }),
    );
    expect(bare.status).toBe(201);
    const longPath = `images/${Array.from({ length: 4 }, () => "p".repeat(200)).join("/")}.png`;
    const updated = await publish(
      s.owner,
      "png-bytes-1",
      { artifactId: s.artifactId, baseVersionId: s.versionId },
      longPath,
    );
    const response = await s.owner.call(
      `${s.base}/threads`,
      post({
        versionId: updated.versionId,
        target,
        region: { ...REGION, image: { path: longPath } },
        body: "x",
      }),
    );
    expect(response.status).toBe(400);
    expect((await response.json<{ error: { message: string } }>()).error.message).toMatch(
      /target and its region are larger than 8192 bytes/,
    );
  });

  it("answers someone who may not comment exactly as without a region", async () => {
    const s = await setup();
    const stranger = await client(s.h, "stranger");
    const withRegion = await stranger.call(
      `${s.base}/threads`,
      post({ versionId: s.versionId, target: IMG, region: REGION, body: "x" }),
    );
    const without = await stranger.call(
      `${s.base}/threads`,
      post({ versionId: s.versionId, target: IMG, body: "x" }),
    );
    expect(withRegion.status).toBe(404);
    expect(await withRegion.json()).toEqual(await without.json());
  });

  it("creates the same thread through MCP as through the API", async () => {
    const s = await setup();
    const fromApi = await (
      await s.owner.call(
        `${s.base}/threads`,
        post({ versionId: s.versionId, target: IMG, region: REGION, body: "Same" }),
      )
    ).json<View & Record<string, unknown>>();
    const tool = await s.owner.tool("create_annotation", {
      artifactId: s.artifactId,
      versionId: s.versionId,
      target: IMG,
      region: REGION,
      body: "Same",
      idempotencyKey: "regions-parity-1",
    });
    expect(tool.isError).not.toBe(true);
    const fromTool = tool.structuredContent as unknown as View & Record<string, unknown>;
    expect(fromTool.region).toEqual(fromApi.region);
    const refused = await s.owner.tool("create_annotation", {
      artifactId: s.artifactId,
      versionId: s.versionId,
      target: NOTE,
      region: REGION,
      body: "x",
      idempotencyKey: "regions-parity-2",
    });
    const apiRefused = await s.owner.call(
      `${s.base}/threads`,
      post({ versionId: s.versionId, target: NOTE, region: REGION, body: "x" }),
    );
    expect(refused.structuredContent).toEqual(await apiRefused.json());
    // A retry replays the region from the stored thread.
    const again = await s.owner.tool("create_annotation", {
      artifactId: s.artifactId,
      versionId: s.versionId,
      target: IMG,
      region: REGION,
      body: "Same",
      idempotencyKey: "regions-parity-1",
    });
    expect((again.structuredContent as unknown as View).region).toEqual(fromApi.region);
  });

  it("says whether a history thread's image is unchanged in the current version", async () => {
    const s = await setup();
    const thread = await (
      await s.owner.call(
        `${s.base}/threads`,
        post({ versionId: s.versionId, target: IMG, region: REGION, body: "Button" }),
      )
    ).json<View>();
    const same = await publish(s.owner, "png-bytes-1", {
      artifactId: s.artifactId,
      baseVersionId: s.versionId,
    });
    const afterSame = await (await s.owner.call(`${s.base}?version=all`)).json<{
      threads: View[];
    }>();
    const kept = afterSame.threads.find((t) => t.id === thread.id);
    expect(kept?.current).toBe(false);
    expect(kept?.region?.currentImage).toBe("unchanged");

    await publish(s.owner, "png-bytes-2", {
      artifactId: s.artifactId,
      baseVersionId: same.versionId,
    });
    const afterChange = await (await s.owner.call(`${s.base}?version=all`)).json<{
      threads: View[];
    }>();
    expect(afterChange.threads.find((t) => t.id === thread.id)?.region?.currentImage).toBe(
      "changed",
    );
    const markdown = await (
      await s.owner.call(`${s.base}/export?format=markdown&version=all`)
    ).text();
    expect(markdown).toContain("(image changed in the current version)");
  });

  it("tells the viewer whether image regions are switched on", async () => {
    for (const [options, expected] of [
      [{ env: ON }, true],
      [{}, false],
    ] as const) {
      const h = createHarness(options);
      const owner = await client(h, "viewer");
      const { artifactId } = await publish(owner, "png");
      const cookie = await h.signIn(`regions-viewer-${emails}@example.test`);
      const response = await h.request(`/api/v1/artifacts/${artifactId}/review`, {
        method: "POST",
        headers: { cookie, origin: ORIGIN, "sec-fetch-site": "same-origin" },
      });
      expect(response.status).toBe(200);
      expect(ReviewStart.parse(await response.json()).imageRegions).toBe(expected);
    }
  });
});
