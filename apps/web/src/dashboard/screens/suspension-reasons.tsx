// The statement of reasons the operator recorded (docs/operations.md, "Reports"), shown next to a
// suspension's category on the artifact page, the Branding page and Settings.
import type { SuspensionStatement } from "@portifact/contracts";
import { useFormatDate, useT } from "../context.tsx";

/**
 * The statement of reasons the operator recorded, next to the category: the operator's text shown
 * as written (React escapes it), one paragraph per line.
 */
export function SuspensionReasons({ statement }: { statement: SuspensionStatement }) {
  const t = useT();
  const formatDate = useFormatDate();
  const lines = (text: string) =>
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  return (
    <div className="mt-3 space-y-3">
      <p>
        {t(statement.source === "notice" ? "detail.suspended.notice" : "detail.suspended.review", {
          date: formatDate(statement.decidedAt),
        })}
      </p>
      <div>
        <p className="font-medium">{t("detail.suspended.facts")}</p>
        {lines(statement.facts).map((line, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: the lines never move
          <p key={index} className="mt-1 whitespace-pre-wrap break-words">
            {line}
          </p>
        ))}
      </div>
      <div>
        <p className="font-medium">{t("detail.suspended.ground")}</p>
        {lines(statement.ground).map((line, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: the lines never move
          <p key={index} className="mt-1 whitespace-pre-wrap break-words">
            {line}
          </p>
        ))}
      </div>
    </div>
  );
}
