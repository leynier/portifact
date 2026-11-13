// PR 276 review: the author-delete confirmation names its artifact.
import { expect, it } from "vitest";
import { startFakeServer } from "./testing/fake-server.ts";
import { createHarness } from "./testing/harness.ts";

it("the author-delete confirmation names the artifact being confirmed", async () => {
  const server = await startFakeServer();
  const h = await createHarness({ server, answers: ["delete"] });
  try {
    h.signIn();
    const artifact = server.api.seed();
    const author = "v_AAAAAAAAAAAAAAAA";
    const result = await h.invoke("data", "delete-author", artifact.id, author);
    expect(result.code, result.stderr).toBe(0);
    expect(h.prompts[0]).toContain(author);
    expect(h.prompts[0]).toContain(artifact.id);
  } finally {
    await h.cleanup();
    await server.close();
  }
});
