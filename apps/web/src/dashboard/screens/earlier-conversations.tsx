// The creator's conversations on earlier versions (plan section 5, "Versiones históricas"):
// every thread of a version that is no longer current, grouped by version and read-only. The
// history is the owner's alone, so it asks for every version's threads (`version=all`), the
// same query the review viewer uses for that filter.
import type { AnnotationThreadView, VersionSummary } from "@portifact/contracts";
import { Badge, Button, Callout, Disclosure, LoadingState } from "@portifact/ui";
import { CircleAlert, CircleCheck, CircleDot, MessagesSquare, RefreshCw } from "lucide-react";
import type { ReactNode } from "react";
import { useT } from "../context.tsx";
import { MessageContent, TargetSummary } from "../review/thread-parts.tsx";
import { useThreads } from "../review/use-threads.ts";
import { errorMessage } from "./artifact-list.tsx";

interface VersionGroup {
  versionId: string;
  /** The version's number, or null when it is not among the versions listed above. */
  number: number | null;
  /** Oldest first, so each thread keeps its number within the version. */
  threads: AnnotationThreadView[];
}

/** Earlier versions' threads by version, newest version first, unlisted versions last. */
export function groupByVersion(
  threads: readonly AnnotationThreadView[],
  versions: readonly VersionSummary[],
): VersionGroup[] {
  const numbers = new Map(versions.map((version) => [version.id, version.number]));
  const groups = new Map<string, VersionGroup>();
  for (const thread of threads) {
    if (thread.current) continue;
    const group = groups.get(thread.versionId) ?? {
      versionId: thread.versionId,
      number: numbers.get(thread.versionId) ?? null,
      threads: [],
    };
    group.threads.push(thread);
    groups.set(thread.versionId, group);
  }
  return [...groups.values()].sort(
    (a, b) =>
      (b.number ?? Number.NEGATIVE_INFINITY) - (a.number ?? Number.NEGATIVE_INFINITY) ||
      a.versionId.localeCompare(b.versionId),
  );
}

export function EarlierConversations({
  artifactId,
  versions,
}: {
  artifactId: string;
  versions: readonly VersionSummary[];
}) {
  const t = useT();
  const threads = useThreads(artifactId, "all");
  let content: ReactNode;
  if (threads.isPending) {
    content = <LoadingState label={t("history.conversations.loading")} />;
  } else if (threads.isError && !threads.data) {
    content = (
      <Callout
        tone="error"
        title={t("history.conversations.error")}
        icon={<CircleAlert className="size-5" />}
        action={
          <Button icon={<RefreshCw className="size-4" />} onClick={() => threads.refetch()}>
            {t("action.retry")}
          </Button>
        }
      >
        {errorMessage(t, threads.error)}
      </Callout>
    );
  } else {
    const groups = groupByVersion(threads.data.threads, versions);
    content =
      groups.length === 0 ? (
        <p className="text-sm text-text-muted">{t("history.conversations.empty")}</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {groups.map((group) => (
            <li key={group.versionId}>
              <Disclosure summary={<GroupSummary group={group} />}>
                <ol className="flex flex-col gap-4">
                  {group.threads.map((thread, index) => (
                    <ThreadRecord key={thread.id} thread={thread} number={index + 1} />
                  ))}
                </ol>
              </Disclosure>
            </li>
          ))}
        </ul>
      );
  }
  return (
    <section aria-labelledby="conversations-heading" className="mt-10 flex flex-col gap-4">
      <h2 id="conversations-heading" className="flex items-center gap-2 text-lg font-semibold">
        <MessagesSquare aria-hidden="true" className="size-5" />
        {t("history.conversations.title")}
      </h2>
      <p className="text-sm text-text-muted">{t("history.conversations.description")}</p>
      {threads.isRefetchError ? (
        <Callout
          title={t("history.conversations.refreshFailed")}
          icon={<CircleAlert className="size-5" />}
        >
          {t("list.refreshFailed.body")}
        </Callout>
      ) : null}
      {content}
    </section>
  );
}

function GroupSummary({ group }: { group: VersionGroup }) {
  const t = useT();
  const open = group.threads.filter((thread) => thread.state === "open").length;
  const counts = t("history.conversations.counts", { count: group.threads.length, open });
  return group.number === null
    ? t("history.conversations.unlisted", { counts })
    : t("history.conversations.version", { number: group.number, counts });
}

function ThreadRecord({ thread, number }: { thread: AnnotationThreadView; number: number }) {
  const t = useT();
  const titleId = `earlier-thread-${thread.id}`;
  return (
    <li>
      <article aria-labelledby={titleId} className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <h3 id={titleId} className="text-base font-semibold">
            {t("review.thread.title", { number })}
          </h3>
          {thread.state === "open" ? (
            <Badge icon={<CircleDot className="size-3.5" />}>{t("review.thread.open")}</Badge>
          ) : (
            <Badge emphasis="quiet" icon={<CircleCheck className="size-3.5" />}>
              {t("review.thread.resolved")}
            </Badge>
          )}
        </div>
        <TargetSummary target={thread.target} />
        <ol className="flex flex-col gap-3">
          {thread.messages.map((message) => (
            <li key={message.id} className="flex flex-col gap-1">
              <MessageContent message={message} />
            </li>
          ))}
        </ol>
      </article>
    </li>
  );
}
