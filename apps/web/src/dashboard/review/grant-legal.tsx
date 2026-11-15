// Portifact's legal notice on the consent controls of artifact data (decision 0026, "The grant"):
// both controls, the person's and the one for visitors without an account, say that Portifact
// hosts the page and draws the control, point to the Privacy Policy, and carry a sign-in-wrap
// statement beside Allow, like the login page's notice (docs/legal.md, "Acceptance at sign-in").
// Translated sentences hold `{terms}`, `{acceptableUse}` and `{privacy}`; `linkedSentence` puts
// the links there as elements, never as HTML.
import { buttonClasses } from "@portifact/ui";
import { Fragment, type ReactNode } from "react";
import { useT } from "../context.tsx";
import type { MessageId } from "../i18n/en.ts";

export const LEGAL_LINKS = {
  terms: "https://portifact.com/terms",
  acceptableUse: "https://portifact.com/acceptable-use",
  privacy: "https://portifact.com/privacy",
} as const;

type LegalPage = keyof typeof LEGAL_LINKS;

const LABELS: Record<LegalPage, MessageId> = {
  terms: "dataGrant.legal.terms",
  acceptableUse: "dataGrant.legal.acceptableUse",
  privacy: "dataGrant.legal.privacy",
};

// Control characters no translation or argument holds, so the split finds only the placeholders.
const OPEN = "\u0002";
const CLOSE = "\u0003";
const MARKER = new RegExp(`${OPEN}(\\w+)${CLOSE}`);

function isLegalPage(name: string): name is LegalPage {
  return Object.hasOwn(LEGAL_LINKS, name);
}

/** A translated sentence with the legal pages it names as links that open in a new tab. */
function useLinkedSentence(): (id: MessageId) => ReactNode {
  const t = useT();
  return (id) => {
    const values = Object.fromEntries(
      (Object.keys(LEGAL_LINKS) as LegalPage[]).map((page) => [page, `${OPEN}${page}${CLOSE}`]),
    );
    // With a capturing group, split alternates text and the captured page names.
    const parts = t(id, values).split(MARKER);
    return parts.map((part, index) => {
      const key = `${index}-${part}`;
      if (index % 2 === 0 || !isLegalPage(part)) return <Fragment key={key}>{part}</Fragment>;
      return (
        <a
          key={key}
          href={LEGAL_LINKS[part]}
          target="_blank"
          rel="noopener"
          className={buttonClasses({ intent: "link", size: "inline" })}
        >
          {t(LABELS[part])}
        </a>
      );
    });
  };
}

/** Who draws the control and where Portifact says what it keeps, shown with the control's facts. */
export function GrantNotice() {
  const sentence = useLinkedSentence();
  return <p className="text-sm text-text-muted">{sentence("dataGrant.legal.notice")}</p>;
}

/** The sign-in-wrap statement next to Allow, which names it with `aria-describedby`. */
export function GrantTerms({ id }: { id: string }) {
  const sentence = useLinkedSentence();
  return (
    <p id={id} className="rounded-md border border-border-strong bg-surface p-3 text-sm">
      {sentence("dataGrant.legal.statement")}
    </p>
  );
}
