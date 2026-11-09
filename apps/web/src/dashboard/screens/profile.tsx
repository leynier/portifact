// The profile page (`/profile`, plan section 6, "Cuenta"): who the account is, how it signs in
// and the browsers signed in to it.
import { Avatar, DetailList, PageHeader } from "@portifact/ui";
import { useQueryClient } from "@tanstack/react-query";
import type { Account } from "../api.ts";
import { useFormatDate, useT } from "../context.tsx";
import { useDocumentTitle } from "../use-document-title.ts";
import { BrowserSessions, Section, SignInMethods } from "./account.tsx";
import { ACCOUNT_QUERY } from "./shell.tsx";

export function ProfileScreen() {
  const t = useT();
  const formatDate = useFormatDate();
  useDocumentTitle(t("profile.title"));
  // The shell loads the account before any screen renders.
  const account = useQueryClient().getQueryData<Account>(ACCOUNT_QUERY);
  const email = account?.email ?? "";
  const name = account?.name.trim() ?? "";

  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <PageHeader title={t("profile.title")} description={t("profile.description")} />
      <Section id="profile" title={t("profile.details")}>
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:gap-5">
          <Avatar name={name} email={email} size="lg" tone="solid" letters={2} />
          <div className="min-w-0 flex-1">
            <DetailList
              framed={false}
              items={[
                ...(name ? [{ term: t("account.name"), detail: name }] : []),
                { term: t("account.email"), detail: email },
                ...(account?.createdAt
                  ? [{ term: t("account.memberSince"), detail: formatDate(account.createdAt) }]
                  : []),
              ]}
            />
          </div>
        </div>
      </Section>
      <SignInMethods email={email} />
      <BrowserSessions />
    </div>
  );
}
