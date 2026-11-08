// Test-only Worker of the end-to-end suite. It serves both real Workers from one process, so
// they share one local D1 and R2 exactly as production shares them: artifact hosts go to the
// content Worker, the app host to the app Worker, and the control host (reachable only from the
// test runner, never through the browsers' proxy) to the seeding endpoints in control.ts.
import app from "../../apps/app/src/index.ts";
import content from "../../apps/content/src/index.ts";
import { CONTROL_HOST, control, type E2eEnv } from "./control.ts";

export default {
  fetch(request, env, ctx) {
    const host = new URL(request.url).hostname;
    if (host === CONTROL_HOST) return control(request, env);
    if (host.endsWith(`.${env.CONTENT_DOMAIN}`)) return content.fetch(request, env, ctx);
    return app.fetch(request, env, ctx);
  },
} satisfies ExportedHandler<E2eEnv>;
