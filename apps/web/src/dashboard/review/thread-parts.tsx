// Read-only pieces of a thread shared by the review viewer and the history's earlier
// conversations. Quotes, names and bodies are untrusted text and are only rendered as text.
import type { AnnotationMessageView, AnnotationTarget } from "@portifact/contracts";
import { Badge } from "@portifact/ui";
import { EyeOff } from "lucide-react";
import type { ReactNode } from "react";
import { useFormatDate, useT } from "../context.tsx";

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

/** Who wrote a message and when, whether it is hidden, and its body or why it has none. */
export function MessageContent({ message }: { message: AnnotationMessageView }) {
  const t = useT();
  const formatDate = useFormatDate();
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
    <>
      <p className="text-sm">
        <span className="font-medium">{author}</span>{" "}
        <span className="text-text-muted">
          <time dateTime={message.createdAt}>{formatDate(message.createdAt, true)}</time>
          {message.editedAt ? ` · ${t("review.message.edited")}` : ""}
        </span>
      </p>
      {message.state === "hidden" && message.body !== null ? (
        <Badge emphasis="quiet" icon={<EyeOff className="size-3.5" />}>
          {t("review.message.hidden")}
        </Badge>
      ) : null}
      {body}
    </>
  );
}
