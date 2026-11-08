// Test-only Worker of the end-to-end suite. It serves both real Workers from one process, so
// they share one local D1 and R2 exactly as production shares them: artifact hosts go to the
// content Worker, the app host to the app Worker, and the control host (reachable only from the
// test runner, never through the browsers' proxy) to the seeding endpoints in control.ts. The
// content Worker runs on the clock in clock.ts, which tests can move forward.
import app from "../../apps/app/src/index.ts";
import { handle, isolateMeter } from "../../apps/content/src/index.ts";
import { contentNow } from "./clock.ts";
import { CONTROL_HOST, control, type E2eEnv } from "./control.ts";

export default {
  fetch(request, env, ctx) {
    const host = new URL(request.url).hostname;
    if (host === CONTROL_HOST) return control(request, env);
    if (host.endsWith(`.${env.CONTENT_DOMAIN}`)) {
      return handle(request, env, contentNow(), (charge) =>
        isolateMeter(env).count(charge, (promise) => ctx.waitUntil(promise)),
      );
    }
    return app.fetch(request, env, ctx);
  },
} satisfies ExportedHandler<E2eEnv>;
