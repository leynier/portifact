// Test-only Worker of the end-to-end suite. It serves both real Workers from one process, so
// they share one local D1 and R2 exactly as production shares them: artifact hosts go to the
// content Worker, the app host to the app Worker, and the control host (reachable only from the
// test runner, never through the browsers' proxy) to the seeding endpoints in control.ts. The
// content Worker runs on the clock in clock.ts, which tests can move forward per artifact.
//
// The app Worker gets the two external boundaries of sign-in replaced, like the app tests do:
// emails are kept in the local bucket for the control host to read (`/mail`), and siteverify
// accepts only the fake Turnstile's token (../src/turnstile-fake.ts). Custom domains use the
// in-memory Cloudflare and DNS of ./domains.ts, which the control host drives. Single sign-on
// talks to the fake identity provider of ./sso.ts, whose authorize page this Worker serves too.
//
// The stack has no Cloudflare edge, so nothing sets CF-Connecting-IP: a test that needs a client
// address (a workspace's network policy, decision 0020) sends `x-e2e-client-ip`, which this
// Worker alone turns into CF-Connecting-IP before either Worker sees the request. Production code
// reads only CF-Connecting-IP, which Cloudflare sets and a client cannot.

import { workerDeps } from "../../apps/app/src/auth/deps.ts";
import type { EmailSender } from "../../apps/app/src/auth/email.ts";
import { createWorker } from "../../apps/app/src/index.ts";
import {
  handle,
  isolateMeter,
  isolateOpenings,
  isolateViews,
} from "../../apps/content/src/index.ts";
import { IDP_HOST, SITE_HOST } from "../src/hosts.ts";
import { TURNSTILE_PASS } from "../src/turnstile-fake.ts";
import { contentNow } from "./clock.ts";
import { CONTROL_HOST, control, type E2eEnv, MAIL_PREFIX } from "./control.ts";
import { e2eDomains } from "./domains.ts";
import { e2eGitHubIssuer } from "./github-oidc.ts";
import { e2eTrackers } from "./integrations.ts";
import { e2eIdp, idpPage } from "./sso.ts";

function capturedEmail(bucket: R2Bucket): EmailSender {
  return {
    async send(message) {
      await bucket.put(`${MAIL_PREFIX}${message.to.toLowerCase()}`, JSON.stringify(message));
    },
  };
}

async function fakeSiteverify(_input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const form = init?.body instanceof FormData ? init.body : new FormData();
  const passed = form.get("response") === TURNSTILE_PASS && form.get("secret") !== null;
  return Response.json(
    passed ? { success: true } : { success: false, "error-codes": ["invalid-input-response"] },
  );
}

const app = createWorker((env) => ({
  ...workerDeps(env),
  email: capturedEmail(env.ARTIFACTS),
  siteverify: fakeSiteverify,
  domains: e2eDomains,
  // Workspace email domain proofs read the same in-memory DNS; never the real resolver.
  emailDomains: { txt: e2eDomains.txt },
  ssoFetch: e2eIdp.fetch,
  // GitHub and Linear are fakes too (decision 0018).
  integrationFetch: e2eTrackers.fetch,
  // GitHub's OIDC key set is a fake issuer too (decision 0024).
  githubOidcFetch: e2eGitHubIssuer.fetch,
}));

/**
 * The site's preference cookie is shared under `Domain=portifact.com`; on the stand-in host the
 * browser would refuse that domain, so it gets the stand-in's own (`PREFERENCE_DOMAINS`).
 */
function siteCookies(response: Response): Response {
  const cookies = response.headers.getSetCookie();
  if (cookies.length === 0) return response;
  const rewritten = new Response(response.body, response);
  rewritten.headers.delete("Set-Cookie");
  for (const cookie of cookies) {
    rewritten.headers.append(
      "Set-Cookie",
      cookie.replace("Domain=portifact.com", `Domain=${SITE_HOST}`),
    );
  }
  return rewritten;
}

/** The test header standing in for the address Cloudflare would report. */
const E2E_CLIENT_IP = "x-e2e-client-ip";

/** The request as Cloudflare's edge would hand it on: CF-Connecting-IP from the test's header. */
function atEdge(request: Request): Request {
  const ip = request.headers.get(E2E_CLIENT_IP);
  const edged = new Request(request);
  edged.headers.delete(E2E_CLIENT_IP);
  // Whatever a client sent as CF-Connecting-IP is dropped, as the edge would overwrite it.
  edged.headers.delete("CF-Connecting-IP");
  if (ip) edged.headers.set("CF-Connecting-IP", ip);
  return edged;
}

export default {
  async fetch(incoming, env, ctx) {
    const request = atEdge(incoming);
    const host = new URL(request.url).hostname;
    if (host === CONTROL_HOST) return control(request, env);
    if (host === IDP_HOST) return idpPage(request);
    // The site host plays portifact.com, which the app Worker serves by that exact name.
    if (host === SITE_HOST) {
      const url = new URL(request.url);
      url.hostname = "portifact.com";
      return siteCookies(await app.fetch(new Request(url, request), env, ctx));
    }
    // Artifact hosts, and any other name but the app's: custom hosts (decision 0006).
    if (host.endsWith(`.${env.CONTENT_DOMAIN}`) || host !== new URL(env.APP_ORIGIN).hostname) {
      // Like the content Worker's own fetch: traffic, access log and view batches after the
      // response, each in the artifact's region (decision 0005).
      const waitUntil = (promise: Promise<unknown>) => ctx.waitUntil(promise);
      return handle(
        request,
        env,
        contentNow(host),
        (charge, region) => isolateMeter(env, region).count(charge, waitUntil),
        (opening, region) => isolateOpenings(env, region).record(opening, waitUntil),
        (view, region) => isolateViews(env, region).count(view, waitUntil),
      );
    }
    return app.fetch(request, env, ctx);
  },
} satisfies ExportedHandler<E2eEnv>;
