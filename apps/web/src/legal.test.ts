import { readFileSync } from "node:fs";
import { TERMS_VERSION } from "@portifact/contracts/terms-version";
import { describe, expect, it } from "vitest";

const read = (name: string) => readFileSync(new URL(`../${name}.html`, import.meta.url), "utf8");

const LEGAL = [
  { slug: "terms", title: "Terms of Service" },
  { slug: "privacy", title: "Privacy Policy" },
  { slug: "acceptable-use", title: "Acceptable Use Policy" },
  { slug: "dpa", title: "Data Processing Addendum" },
];

const EFFECTIVE = new Date(`${TERMS_VERSION}T00:00:00Z`).toLocaleDateString("en-US", {
  month: "long",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});

function legalLinks(html: string): string[] {
  const nav = /<nav\b[^>]*\baria-label="Legal"[^>]*>([\s\S]*?)<\/nav>/.exec(html)?.[1] ?? "";
  return [...nav.matchAll(/href="([^"]+)"/g)].map((match) => match[1] ?? "");
}

describe("legal pages", () => {
  for (const { slug, title } of LEGAL) {
    describe(slug, () => {
      const html = read(slug);

      it("has the landmarks, one h1 and its title", () => {
        expect(html).toMatch(/<html lang="en"[\s>]/);
        expect(html).toContain('href="#main"');
        expect(html).toContain('<main id="main"');
        expect(html.match(/<h1\b/g)).toHaveLength(1);
        expect(html).toContain(`>${title}</h1>`);
        expect(html).toMatch(new RegExp(`<title[^>]*>${title}: Portifact</title>`));
        expect(html).toContain(`<link rel="canonical" href="https://portifact.com/${slug}" />`);
        for (const img of html.match(/<img\b[^>]*>/g) ?? []) expect(img).toMatch(/\balt="[^"]+"/);
      });

      it("shows the current version and date, with no draft notice", () => {
        expect(html).not.toContain("Draft pending legal review");
        expect(html).toContain(`<span data-terms-version>${TERMS_VERSION}</span>`);
        expect(html).toContain(`<time datetime="${TERMS_VERSION}">${EFFECTIVE}</time>`);
      });

      it("links every table of contents entry to a section heading", () => {
        const toc = /<nav aria-labelledby="toc-heading"[\s\S]*?<\/nav>/.exec(html)?.[0] ?? "";
        const targets = [...toc.matchAll(/href="#([^"]+)"/g)].map((match) => match[1]);
        expect(targets.length).toBeGreaterThan(3);
        for (const id of targets) {
          expect(html).toContain(`<section id="${id}" aria-labelledby="${id}-heading"`);
          expect(html).toContain(`<h2 id="${id}-heading"`);
        }
      });

      it("links the four legal pages from its footer and marks itself as current", () => {
        expect(legalLinks(html)).toEqual(["/terms", "/privacy", "/acceptable-use", "/dpa"]);
        expect(html).toMatch(new RegExp(`href="/${slug}"[^>]*aria-current="page"`));
      });

      it("loads no script, so it works without JavaScript under the strict CSP", () => {
        expect(html).not.toMatch(/<script\b/);
        expect(html).not.toMatch(/<style\b/);
        expect(html).not.toMatch(/\son[a-z]+=/);
      });

      it("keeps headings free of trailing periods and has no em dashes", () => {
        for (const match of html.matchAll(/<(h[1-6]|title)\b[^>]*>([\s\S]*?)<\/\1>/g)) {
          expect((match[2] ?? "").replace(/<[^>]+>/g, "").trim()).not.toMatch(/\.$/);
        }
        expect(html).not.toContain("—");
      });

      it("gives every table a caption and header cells", () => {
        for (const table of html.match(/<table\b[\s\S]*?<\/table>/g) ?? []) {
          expect(table).toMatch(/<caption\b[^>]*>[^<]+<\/caption>/);
          expect(table).toContain('<th scope="col"');
          expect(table).toContain('<th scope="row"');
        }
      });
    });
  }

  it("covers what each document needs", () => {
    const terms = read("terms");
    for (const text of [
      "18 or older",
      "State of Florida",
      "Limitation of liability",
      "Disclaimers",
      "Changes to these terms",
      "Ending your use",
      "abuse@portifact.com",
      "rights needed to host",
      "30 days",
      "six months",
      'id="suggestions"',
      "you grant the customer that holds the artifact's personal space or workspace a non-exclusive",
      "Accepting and rejecting require an authorized person's dashboard session",
      "If there are only change-list items, successful acceptance records those items without publishing a version",
      "This is not a blanket waiver of moral rights",
    ]) {
      expect(terms, text).toContain(text);
    }
    const privacy = read("privacy");
    for (const text of [
      "privacy@portifact.com",
      "Cloudflare",
      "Cloudflare Email Service",
      "Google and GitHub",
      "How long we keep it",
      "Access logs (who opened an artifact and when)",
      "__Host-pf.session_token",
      "__Host-pf_terms",
      "<strong>Edit suggestions.</strong>",
      "<strong>Change lists.</strong>",
      "preview.portifact.dev",
      "Change list items",
      "This endpoint does not read or set cookies",
      "a deleted-account label does not remove personal information",
      "Eligibility or access expiry does not mean instantaneous erasure from storage",
    ]) {
      expect(privacy, text).toContain(text);
    }
    const aup = read("acceptable-use");
    for (const text of [
      "phishing",
      "malware",
      "mines cryptocurrency",
      "sexually explicit",
      "pirated",
      "impersonates",
      "abuse@portifact.com",
    ]) {
      expect(aup, text).toContain(text);
    }
    const dpa = read("dpa");
    for (const text of [
      "Implementing Decision (EU) 2021/914",
      "Module Two",
      "Module Three",
      "International Data Transfer Addendum",
      "Swiss Federal Data Protection and Information Commissioner",
      "without undue delay",
      "Module Three (processor to processor) where you are a processor acting with your controller's authorization",
      "at least 14 days' notice",
      "specific written authorization",
      "private written annex",
      "Cloudflare, Inc.",
      'id="annex-i"',
      'id="annex-ii"',
      'id="subprocessors"',
      "change lists and drafts of edits",
    ]) {
      expect(dpa, text).toContain(text);
    }
  });

  it("describes files and screenshots on comments as the product handles them (decision 0029)", () => {
    const terms = read("terms");
    for (const text of [
      "Ownership of files and screenshots attached to comments remains with the respective rights holders",
      "attaching a file permits authorized recipients to view, download and retain it",
      "grants no unrelated redistribution rights",
      "stay in your browser until you post the comment and are uploaded only then",
      "Changing access does not invalidate issued links",
      "The version of November 15, 2026 added files and screenshots on comments",
      "<code>portifact export</code> downloads every file",
      "up to 4 files to a comment or reply",
      "each up to 10 MB (1 MB for text)",
      "from its contents, not its name",
      "Files can be added only from the dashboard",
      "Files attached to comments</th>",
    ]) {
      expect(terms, text).toContain(text);
    }
    const privacy = read("privacy");
    for (const text of [
      "<strong>Files on comments.</strong>",
      "If an upload is not posted with its comment within an hour",
      "we never capture your screen or the artifact ourselves",
      "a file you remove or a comment you abandon is never uploaded",
      "We cannot recall copies already downloaded.",
      "Recorded deletions are reapplied during restore, subject to the backup limitations below.",
      "Unreferenced attachment objects are removed after reconciliation.",
      "Files on comments</th>",
    ]) {
      expect(privacy, text).toContain(text);
    }
    expect(read("dpa")).toContain("files and screenshots attached to them");
    expect(read("dpa")).toContain("of files attached to comments");
    expect(read("acceptable-use")).toContain("every comment and every file attached to one");
    expect(read("acceptable-use")).toContain(
      "a small file or a single screenshot is not an exception",
    );
  });

  it("describes artifact data as the product handles it (decision 0026)", () => {
    const terms = read("terms");
    expect(terms).not.toContain("servers or databases for your content");
    for (const text of [
      'id="artifact-data"',
      "This version replaces the version of November 15, 2026 and takes effect on November 16, 2026.",
      "It belongs to the artifact, not to a version.",
      "never their email address or account ID",
      "The permission lasts up to 30 days in that browser",
      "a revocation takes effect within a minute",
      "Saving needs the current version of these terms",
      "A service token reaches it only with the data scopes an admin grants the token",
      "renewed every minute by the same sign-in or permission that opened it",
      "Artifact data does not count in the space's storage quota",
      "we may pause new writes and new live connections; that pause never blocks reads, exports or deletions",
      "These terms instruct us, on the customer's behalf",
      "which lasts up to 7 days in that browser",
      "Each permission gets a new ID",
      "You cannot run SQL or custom server-side code on it",
      "accepts these terms and confirms the visitor is 18 or older",
      "there is no account-based self-service history",
      "to read, reproduce, retain, export, modify and delete what they save",
      "lists every artifact where you saved as a signed-in visitor, whether or not your permission still exists",
      "a large download continues from where it stopped on a later day, and deletion runs in bounded batches",
      "We keep the request until it is delivered, and retry it",
      "by email to that visitor too",
      "no further artifact can start holding data",
      "Artifacts that can hold artifact data</th>",
      "Artifact data of one artifact</th>",
      "<code>portifact data export</code>",
      "Documents you saved in other people's artifacts</th>",
      'Not part of the "Download your data" page or <code>portifact export</code>',
      "Artifact data is not deleted when a plan ends, is removed or is lowered",
    ]) {
      expect(terms, text).toContain(text);
    }
    const privacy = read("privacy");
    for (const text of [
      "About artifact data</h3>",
      "This version replaces the version of November 15, 2026 and takes effect on November 16, 2026.",
      "never your account ID or email address from us",
      "no account, name, email or network address",
      "under a keyed identifier derived from it, never the address itself, which is pseudonymous",
      "passed to Cloudflare Turnstile",
      "its stored hashes are removed when it is used or by cleanup after it expires",
      "is then deleted by a scheduled cleanup, except while it is still needed for a pending erasure",
      "We keep the request until the email is delivered",
      "per-visitor connection-rate counters remain",
      "This depends on the activity, not on whether the space is personal or used for work.",
      "What visitors save from the page is not recorded in the audit log.",
      "Artifact data is not in these database backups and is not restored from them",
      "revoked permissions to save artifact data",
      "Permissions to save artifact data</th>",
      "Records linking an account to its ID in an artifact's data</th>",
      "with a hint for western North America",
      "Choosing Allow before a page saves what you enter is a choice you make in the product",
      "see every artifact where you saved as a signed-in visitor",
    ]) {
      expect(privacy, text).toContain(text);
    }
    const dpa = read("dpa");
    for (const text of [
      "the data their pages save (artifact data",
      "For artifact data, your instructions also include these",
      "visitors who save data in its artifacts, including people without an account",
      "Stores each artifact's data in its own SQLite database",
      "Cloudflare's storage for artifact data can keep earlier states for up to 30 days",
      "whose pages collect it, since whoever determines why a page collects data acts as its controller",
      "people whose information visitors include in what they save",
      "we do not collect additional identity information solely to identify otherwise unidentifiable visitors",
    ]) {
      expect(dpa, text).toContain(text);
    }
    const aup = read("acceptable-use");
    for (const text of [
      'id="artifact-data"',
      "everything saved in an artifact's data",
      "Do not collect data from visitors without telling them.",
      "Do not ask visitors for passwords, sign-in codes, payment card details or other credentials",
      "to track people across sites or artifacts",
      "you need not discover identifiers the page does not show",
      "by email to that visitor too",
    ]) {
      expect(aup, text).toContain(text);
    }
  });

  it("links the Data Processing Addendum from the Terms and the Privacy Policy", () => {
    expect(read("terms")).toContain('<a href="/dpa">Data Processing Addendum</a>');
    expect(read("privacy")).toContain('href="/dpa#subprocessors"');
  });

  it("lists every cookie Portifact sets in the Privacy Policy", () => {
    const privacy = read("privacy");
    for (const cookie of [
      "__Host-pf.session_token",
      "__Host-pf.state",
      "__Host-pf_terms",
      "__Host-pf_human",
      "__Secure-pf_theme",
      "__Secure-pf_lang",
      "__Host-pf_read",
      "__Host-pf_read_tx_",
      "__Host-pf_link",
      "__Host-pf_review",
      "__Host-pf_review_tab",
      "__Host-pf_nobar",
      "__Host-pf_grant",
      "__Host-pf_grant_tx",
    ]) {
      expect(privacy, cookie).toContain(cookie);
    }
  });

  it("opens the Terms and the Privacy Policy with what changed", () => {
    for (const slug of ["terms", "privacy"]) {
      expect(read(slug), slug).toContain(
        '<section id="what-changed" aria-labelledby="what-changed-heading"',
      );
    }
  });
});

describe("legal links", () => {
  it("are in the landing page footer with the report form and the abuse address", () => {
    const html = read("index");
    expect(legalLinks(html)).toEqual([
      "/terms",
      "/privacy",
      "/acceptable-use",
      "/dpa",
      "https://app.portifact.com/report",
      "mailto:abuse@portifact.com",
    ]);
  });

  it("are in the footer of every auth page, on the site's origin", () => {
    for (const page of ["login", "device", "consent", "report", "unsubscribe"]) {
      expect(legalLinks(read(page)), page).toEqual([
        "https://portifact.com/",
        "https://portifact.com/terms",
        "https://portifact.com/privacy",
        "https://portifact.com/acceptable-use",
        "https://portifact.com/dpa",
      ]);
    }
  });
});
