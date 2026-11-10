import { LOCALE_CODES } from "@portifact/contracts/locales";
import { describe, expect, it } from "vitest";
import { DIRECTORY_NOTICE_TEXT, directoryNoticeEmail } from "./directory-notice.ts";

const WORKSPACE = "https://app.portifact.com/?workspace=engines";
const MEMBERS = "https://app.portifact.com/members?workspace=engines";

describe("the notice of being added by a directory", () => {
  it("says who added the person, links the workspace and says how to leave", () => {
    const email = directoryNoticeEmail({
      workspaceName: "Analytical Engines",
      workspaceUrl: WORKSPACE,
      membersUrl: MEMBERS,
    });
    expect(email.subject).toBe("You were added to Analytical Engines");
    expect(email.text).toContain(
      "Your organization's directory added your Portifact account to the workspace Analytical Engines as a member.",
    );
    expect(email.text).toContain(`Open the workspace: ${WORKSPACE}`);
    expect(email.text).toContain(`Members page (${MEMBERS})`);
    expect(email.text).toContain("does not add you back");
    expect(email.html).toContain(`href="${WORKSPACE}"`);
    expect(email.html).toContain(`href="${MEMBERS}"`);
  });

  it("keeps the workspace name on one line and escapes it", () => {
    const email = directoryNoticeEmail({
      workspaceName: "<b>Team</b>\nFake line",
      workspaceUrl: WORKSPACE,
      membersUrl: MEMBERS,
    });
    expect(email.subject).toBe("You were added to <b>Team</b> Fake line");
    expect(email.html).not.toContain("<b>Team</b>");
    expect(email.html).toContain("&lt;b&gt;Team&lt;/b&gt;");
  });

  it("is written in every language", () => {
    for (const locale of LOCALE_CODES) {
      const email = directoryNoticeEmail({
        workspaceName: "Engines",
        workspaceUrl: WORKSPACE,
        membersUrl: MEMBERS,
        locale,
      });
      expect(email.subject).toBe(DIRECTORY_NOTICE_TEXT[locale].subject("Engines"));
      expect(email.html).toContain(`lang="${locale}"`);
      expect(email.text).toContain(WORKSPACE);
    }
  });
});
