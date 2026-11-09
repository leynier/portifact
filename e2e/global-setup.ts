// Starts the stack once for the whole run; the workers read its addresses from the environment.
import { startStack } from "./src/stack.ts";

export default async function globalSetup() {
  const stack = await startStack();
  process.env.PF_E2E_PROXY = stack.proxyUrl;
  process.env.PF_E2E_CONTROL = stack.controlUrl;
  process.env.PF_E2E_FRONT = stack.frontUrl;
  return () => stack.close();
}
