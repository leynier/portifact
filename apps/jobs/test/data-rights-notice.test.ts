// The notice of a request about the data someone saved in an artifact (decision 0026), as the
// jobs Worker renders and sends it: the artifact's name only in the default region.
import { RecipientSuppressedError } from "@portifact/services";
import { describe, expect, it } from "vitest";
import { dataRightsNotifierFromEnv } from "../src/notices.ts";

function recording() {
  const sent: { to: string; subject: string; text: string }[] = [];
  const email = {
    send: async (message: { to: string; subject: string; text: string }) => {
      sent.push(message);
      return { messageId: "m" };
    },
  } as unknown as SendEmail;
  return { sent, email };
}

const notice = {
  to: "admin@corp.example",
  kind: "erasure" as const,
  artifactId: "k7d2qm4xab",
  artifactName: "Zanzibar board",
  visitorId: "v_7Hc2kQ9xLm4pRt1vWz8aBd",
  workspaceSlug: "acme",
  locale: null,
};

describe("the data rights notice email", () => {
  it("names the artifact in the default region and links it in its space", async () => {
    const { sent, email } = recording();
    await dataRightsNotifierFromEnv(
      { APP_ORIGIN: "https://app.portifact.com", EMAIL: email },
      "default",
    ).send(notice);
    expect(sent[0]?.text).toContain("Zanzibar board");
    expect(sent[0]?.text).toContain(
      "https://app.portifact.com/artifacts/k7d2qm4xab?workspace=acme",
    );
    expect(sent[0]?.text).toContain(notice.visitorId);
  });

  it("names no artifact outside the default region", async () => {
    const { sent, email } = recording();
    await dataRightsNotifierFromEnv(
      { APP_ORIGIN: "https://app.portifact.com", EMAIL: email },
      "eu",
    ).send({
      ...notice,
      workspaceSlug: null,
    });
    expect(sent[0]?.text).not.toContain("Zanzibar");
    expect(sent[0]?.text).toContain("https://app.portifact.com/artifacts/k7d2qm4xab\n");
  });

  it("maps a provider refusal and hides other errors", async () => {
    const failing = (error: Error) =>
      dataRightsNotifierFromEnv(
        {
          APP_ORIGIN: "https://app.portifact.com",
          EMAIL: {
            send: async () => {
              throw error;
            },
          } as unknown as SendEmail,
        },
        "default",
      );
    await expect(failing(new Error("refused admin@corp.example")).send(notice)).rejects.toThrow(
      /^email delivery failed$/,
    );
    const suppressed = Object.assign(new Error("x"), { code: "E_RECIPIENT_SUPPRESSED" });
    await expect(failing(suppressed).send(notice)).rejects.toBeInstanceOf(RecipientSuppressedError);
  });
});
