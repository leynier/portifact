// The notice of being added to a workspace by its directory (decision 0017), as the jobs Worker
// renders and sends it.
import { RecipientSuppressedError } from "@portifact/services";
import { describe, expect, it } from "vitest";
import { directoryNotifierFromEnv } from "../src/notices.ts";

describe("the directory notice email", () => {
  it("renders in the person's language with the workspace and its Members page", async () => {
    const sent: { to: string; subject: string; text: string }[] = [];
    const notifier = directoryNotifierFromEnv({
      APP_ORIGIN: "https://app.portifact.com",
      EMAIL: {
        send: async (message: { to: string; subject: string; text: string }) => {
          sent.push(message);
          return { messageId: "m" };
        },
      } as unknown as SendEmail,
    });
    await notifier.send({
      to: "ada@corp.example",
      workspaceName: "Engines",
      workspaceSlug: "engines",
      locale: "es",
    });
    expect(sent[0]?.to).toBe("ada@corp.example");
    expect(sent[0]?.subject).toBe("Te agregaron a Engines");
    expect(sent[0]?.text).toContain("https://app.portifact.com/?workspace=engines");
    expect(sent[0]?.text).toContain("https://app.portifact.com/members?workspace=engines");
    await notifier.send({
      to: "b@corp.example",
      workspaceName: "E",
      workspaceSlug: "e",
      locale: null,
    });
    expect(sent[1]?.subject).toBe("You were added to E");
  });

  it("maps a provider refusal and hides other errors", async () => {
    const failing = (error: Error) =>
      directoryNotifierFromEnv({
        APP_ORIGIN: "https://app.portifact.com",
        EMAIL: {
          send: async () => {
            throw error;
          },
        } as unknown as SendEmail,
      });
    const notice = { to: "ada@corp.example", workspaceName: "E", workspaceSlug: "e", locale: null };
    await expect(failing(new Error("refused ada@corp.example")).send(notice)).rejects.toThrow(
      /^email delivery failed$/,
    );
    const suppressed = Object.assign(new Error("suppressed"), { code: "E_RECIPIENT_SUPPRESSED" });
    await expect(failing(suppressed).send(notice)).rejects.toBeInstanceOf(RecipientSuppressedError);
  });
});
