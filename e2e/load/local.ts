// Local target of the load test (scripts/load-test.ts): the e2e Worker, which serves the real app
// and content Workers over one local D1 and R2, in workerd through wrangler. Requests reach it with
// MF-Original-URL, so each Worker sees its production-like host, and presigned uploads go to the
// control host's storage stand-in, which streams them into the local R2 bucket.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unstable_startWorker } from "wrangler";
import { send } from "../../scripts/load/http.ts";
import { type Target, treeRss } from "../../scripts/load/target.ts";

const E2E_DIR = new URL("..", import.meta.url).pathname;
const APP_ORIGIN = "https://app.portifact.test";
const CONTENT_DOMAIN = "portifact-content.test";
const CONTROL = "https://control.e2e.test";
const BUCKET = "portifact-e2e";

export async function startLocalTarget(): Promise<Target> {
  const persist = mkdtempSync(join(tmpdir(), "pf-load-state-"));
  execFileSync(
    "npx",
    ["wrangler", "d1", "migrations", "apply", "portifact-e2e", "--local", "--persist-to", persist],
    { cwd: E2E_DIR, stdio: "ignore", env: { ...process.env, CI: "1" } },
  );
  const worker = await unstable_startWorker({
    config: join(E2E_DIR, "wrangler.jsonc"),
    dev: {
      persist,
      // HTTPS like production and the e2e stack: the app refuses session mutations whose
      // Origin does not match the scheme it sees.
      server: { hostname: "127.0.0.1", port: 0, secure: true },
      inspector: false,
      logLevel: "error",
      watch: false,
    },
  });
  await worker.ready;
  const address = await worker.url;

  const request: Target["request"] = (input) =>
    send({
      ...input,
      url: new URL(new URL(input.url).pathname + new URL(input.url).search, address).href,
      headers: { ...input.headers, "MF-Original-URL": input.url },
      selfSigned: true,
    });

  const control = async <T>(path: string, body: unknown): Promise<T> => {
    const sent = await request({
      method: "POST",
      url: `${CONTROL}${path}`,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (sent.status !== 200) throw new Error(`control ${path}: ${sent.status} ${sent.body}`);
    return JSON.parse(sent.body.toString("utf8")) as T;
  };

  return {
    kind: "local",
    appOrigin: APP_ORIGIN,
    contentDomain: CONTENT_DOMAIN,
    request,
    upload(url, headers, body) {
      // https://<account>.r2.cloudflarestorage.com/<bucket>/<key>?X-Amz-...
      const path = new URL(url).pathname.split("/").slice(1).map(decodeURIComponent);
      if (path[0] !== BUCKET) throw new Error(`Unexpected upload URL ${new URL(url).host}`);
      const key = path.slice(1).join("/");
      // A multipart part carries its upload ID and part number, as S3 UploadPart does.
      const signed = new URL(url).searchParams;
      const query = new URLSearchParams({ key });
      for (const name of ["uploadId", "partNumber"]) {
        const value = signed.get(name);
        if (value !== null) query.set(name, value);
      }
      return request({
        method: "PUT",
        url: `${CONTROL}/storage?${query}`,
        headers,
        body,
      });
    },
    seed: {
      async user(email) {
        const user = await control<{ userId: string; cookie: string }>("/user", {
          email,
          name: email.split("@")[0],
        });
        return { userId: user.userId, email, auth: { kind: "cookie", cookie: user.cookie } };
      },
      publish: (input) =>
        control<{ artifactId: string; versionId: string }>("/publish", { type: "site", ...input }),
      sql: (query, params = []) => control<Record<string, unknown>[]>("/sql", { query, params }),
      async thread(input) {
        await control("/thread", { ...input, path: "index.html" });
      },
    },
    memoryBytes: () => treeRss(process.pid),
    async close() {
      await worker.dispose();
      rmSync(persist, { recursive: true, force: true });
    },
  };
}
