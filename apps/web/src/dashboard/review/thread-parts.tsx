// Read-only pieces of a thread shared by the review viewer and the history's earlier
// conversations. Quotes, names and bodies are untrusted text and are only rendered as text.
import type { AnnotationMessageView, AnnotationTarget } from "@portifact/contracts";
import { Avatar, Badge } from "@portifact/ui";
import { EyeOff } from "lucide-react";
import type { ReactNode } from "react";
import { useFormatDate, useRelativeTime, useT } from "../context.tsx";

/**
 * What the thread points at: the whole page, an element or a quote. `compact` keeps a long quote
 * to two lines, for a composer floating over the artifact.
 */
export function TargetSummary({
  target,
  compact = false,
}: {
  target: AnnotationTarget;
  compact?: boolean;
}) {
  const t = useT();
  const { anchor } = target;
  if (anchor.kind === "document") {
    return (
      <p className="text-sm text-text-muted">{t("review.target.general", { path: target.path })}</p>
    );
  }
  if (anchor.kind === "element") {
    return (
      <div className="text-sm">
        <p className="text-text-muted">{t("review.target.element", { tag: anchor.tagName })}</p>
        {anchor.fingerprint ? (
          <blockquote
            className={`mt-1 border-l-2 border-border-strong pl-3 break-words ${compact ? "line-clamp-2" : ""}`}
          >
            {anchor.fingerprint}
          </blockquote>
        ) : null}
      </div>
    );
  }
  return (
    <figure className="text-sm">
      <figcaption className="sr-only">{t("review.target.quote")}</figcaption>
      <blockquote
        className={`border-l-2 border-border-strong pl-3 break-words ${compact ? "line-clamp-2" : ""}`}
      >
        {anchor.quote.exact}
      </blockquote>
    </figure>
  );
}

/**
 * One message: the author's initial, name and how long ago they wrote it (the full date on
 * hover), whether it is hidden, and its body or why it has none. `actions` sit at the end of the
 * author's line, such as the message's menu.
 */
export function MessageContent({
  message,
  actions,
}: {
  message: AnnotationMessageView;
  actions?: ReactNode;
}) {
  const t = useT();
  const formatDate = useFormatDate();
  const relative = useRelativeTime();
  const author = message.own
    ? t("review.message.you")
    : (message.author?.name ?? t("review.message.formerAccount"));
  let body: ReactNode;
  if (message.state === "deleted") {
    body = <p className="text-sm text-text-muted italic">{t("review.message.deleted")}</p>;
  } else if (message.body === null) {
    body = <p className="text-sm text-text-muted italic">{t("review.message.hidden")}</p>;
  } else {
    body = <p className="text-sm whitespace-pre-wrap break-words">{message.body}</p>;
  }
  return (
    <div className="flex gap-2.5">
      <Avatar name={message.author?.name || author} />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex min-h-6 items-center gap-2">
          <p className="min-w-0 flex-1 text-sm">
            <span className="font-medium break-words">{author}</span>{" "}
            <span className="text-xs text-text-muted">
              <time dateTime={message.createdAt} title={formatDate(message.createdAt, true)}>
                {relative(message.createdAt)}
              </time>
              {message.editedAt ? ` · ${t("review.message.edited")}` : ""}
            </span>
          </p>
          {actions}
        </div>
        {message.state === "hidden" && message.body !== null ? (
          <div>
            <Badge emphasis="quiet" icon={<EyeOff className="size-3.5" />}>
              {t("review.message.hidden")}
            </Badge>
          </div>
        ) : null}
        {body}
      </div>
    </div>
  );
}
