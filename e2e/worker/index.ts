// Test-only Worker of the end-to-end suite. It serves both real Workers from one process, so
// they share one local D1 and R2 exactly as production shares them: artifact hosts go to the
// content Worker, the app host to the app Worker, and the control host (reachable only from the
// test runner, never through the browsers' proxy) to the seeding endpoints in control.ts. The
// content Worker runs on the clock in clock.ts, which tests can move forward per artifact.
//
// The app Worker gets the two external boundaries of sign-in replaced, like the app tests do:
// emails are kept in the local bucket for the control host to read (`/mail`), and siteverify
// accepts only the fake Turnstile's token (../src/turnstile-fake.ts).

import { workerDeps } from "../../apps/app/src/auth/deps.ts";
import type { EmailSender } from "../../apps/app/src/auth/email.ts";
import { createWorker } from "../../apps/app/src/index.ts";
import { handle, isolateMeter, isolateOpenings } from "../../apps/content/src/index.ts";
import { TURNSTILE_PASS } from "../src/turnstile-fake.ts";
import { contentNow } from "./clock.ts";
import { CONTROL_HOST, control, type E2eEnv, MAIL_PREFIX } from "./control.ts";

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
}));

export default {
  fetch(request, env, ctx) {
    const host = new URL(request.url).hostname;
    if (host === CONTROL_HOST) return control(request, env);
    if (host.endsWith(`.${env.CONTENT_DOMAIN}`)) {
      // Like the content Worker's own fetch: traffic and access log batches after the response.
      const waitUntil = (promise: Promise<unknown>) => ctx.waitUntil(promise);
      return handle(
        request,
        env,
        contentNow(host),
        (charge) => isolateMeter(env).count(charge, waitUntil),
        (opening) => isolateOpenings(env).record(opening, waitUntil),
      );
    }
    return app.fetch(request, env, ctx);
  },
} satisfies ExportedHandler<E2eEnv>;
