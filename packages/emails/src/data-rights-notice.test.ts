import { LOCALE_CODES } from "@portifact/contracts/locales";
import { describe, expect, it } from "vitest";
import { dataRightsNoticeEmail } from "./data-rights-notice.ts";

const base = {
  visitorId: "v_7Hc2kQ9xLm4pRt1vWz8aBd",
  dataUrl: "https://app.portifact.com/artifacts/k7d2qm4xab",
};

describe("the data rights notice", () => {
  it("names the visitor by ID only, links the artifact and keeps the name out of the subject", () => {
    const email = dataRightsNoticeEmail({ ...base, kind: "erasure", artifactName: "Zanzibar <b>" });
    expect(email.subject).not.toContain("Zanzibar");
    expect(email.text).toContain("Zanzibar <b>");
    expect(email.html).toContain("Zanzibar &lt;b&gt;");
    expect(email.html).not.toContain("<b>");
    expect(email.text).toContain(base.visitorId);
    expect(email.text).toContain(base.dataUrl);
    expect(email.text).toContain("erase");
  });

  it("names no artifact where the region keeps names out, in every language", () => {
    for (const locale of LOCALE_CODES) {
      const email = dataRightsNoticeEmail({ ...base, kind: "access", artifactName: null, locale });
      expect(email.text).not.toContain("Zanzibar");
      expect(email.text).toContain(base.visitorId);
      expect(email.html).toContain(`lang="${locale}"`);
    }
  });
});
