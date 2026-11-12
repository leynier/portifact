import { LOCALES } from "@portifact/contracts/locales";
import { describe, expect, it } from "vitest";
import { ACCOUNT_DELETION_CODE_TEXT, accountDeletionCodeEmail } from "./account-deletion-code.ts";
import { signInCodeEmail } from "./sign-in-code.ts";

const input = { email: "ada@example.com", code: "482913", expiresInMinutes: 5 };

describe("account deletion code email", () => {
  it("keeps the code out of the subject and the preview text", () => {
    for (const { code: locale } of LOCALES) {
      const email = accountDeletionCodeEmail({ ...input, locale });
      expect(email.subject, locale).not.toContain("482913");
      const preheader = /<div style="display: none[^>]*>([^<]*)<\/div>/.exec(email.html)?.[1] ?? "";
      expect(preheader, locale).not.toContain("482913");
      expect(email.html, locale).toContain("482913");
      expect(email.text.split("\n"), locale).toContain("482913");
      expect(email.text, locale).toContain("ada@example.com");
    }
  });

  it("says what entering it does, that it signs nobody in, and that it can be ignored", () => {
    const email = accountDeletionCodeEmail(input);
    expect(email.subject).toBe("Your code to delete your Portifact account");
    expect(email.text).toContain("It expires in 5 minutes and works once.");
    expect(email.text).toContain("deletes the account for good, without accepting the new terms");
    expect(email.text).toContain("This code cannot be used to sign in.");
    expect(email.text).toContain("Nothing is deleted without the code.");
    expect(email.text).toContain("service email sent only on request");
    expect(email.text).toMatch(/: https:\/\/portifact\.com\/privacy$/m);
    expect(email.html).toContain('href="https://portifact.com/privacy"');
    expect(email.text).not.toMatch(/unsubscribe/i);
  });

  it("is told apart from the sign-in code email in every language", () => {
    for (const { code: locale } of LOCALES) {
      const deletion = accountDeletionCodeEmail({ ...input, locale });
      const signIn = signInCodeEmail({ ...input, locale });
      expect(deletion.subject, locale).not.toBe(signIn.subject);
      expect(deletion.html, locale).toContain(`<html lang="${locale}"`);
      expect(deletion.text, locale).not.toMatch(/[—–]/);
    }
  });

  it("has every language and the singular minute", () => {
    expect(Object.keys(ACCOUNT_DELETION_CODE_TEXT).sort()).toEqual(
      LOCALES.map((l) => l.code).sort(),
    );
    expect(accountDeletionCodeEmail({ ...input, expiresInMinutes: 1 }).text).toContain(
      "It expires in 1 minute and works once.",
    );
  });

  it("escapes the address", () => {
    const hostile = accountDeletionCodeEmail({ ...input, email: '"<img onerror=x>"@example.com' });
    expect(hostile.html).not.toContain("<img onerror");
  });
});
