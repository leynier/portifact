import { buttonClasses, PageHeader } from "@portifact/ui";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { useT } from "../context.tsx";
import { useDocumentTitle } from "../use-document-title.ts";

/** A link back to the artifact list styled as a button, for screens that end in a dead end. */
export function BackToList({ children }: { children: ReactNode }) {
  return (
    <Link to="/" className={buttonClasses({ intent: "secondary" })}>
      {children}
    </Link>
  );
}

export function NotFoundScreen() {
  const t = useT();
  useDocumentTitle(t("notFound.title"));
  return (
    <>
      <PageHeader title={t("notFound.title")} />
      <p className="mb-6 text-text-muted">{t("notFound.body")}</p>
      <BackToList>{t("detail.back")}</BackToList>
    </>
  );
}
