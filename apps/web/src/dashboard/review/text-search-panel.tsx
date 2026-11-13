// The sidebar's "Suggest a text change" (decision 0027, "Suggesting"): for people who cannot
// select text in the frame, a search over the stored page that opens the same editor on a match.
// The page is read through the API as the person may read it, never from the frame.
import type { AnchorDocument } from "@portifact/anchors";
import { PLAN_LIMITS, type ReviewStart } from "@portifact/contracts";
import { tokens } from "@portifact/domain/suggestion-display";
import { Button, LiveRegion, TextInput, TypedText } from "@portifact/ui";
import { useMutation } from "@tanstack/react-query";
import { Search } from "lucide-react";
import { type FormEvent, useRef, useState } from "react";
import { useDashboard, useT } from "../context.tsx";
import type { TextTarget } from "./suggest-session.ts";
import { useDiffLabels } from "./suggestions.tsx";
import { findMatches, pageDocument, type TextMatch, targetOf } from "./text-search.ts";
import { ActionError } from "./thread-card.tsx";

/** Thrown when the page is not an HTML file the search can read. */
class NotSearchable extends Error {}

export function TextSearchPanel({
  start,
  path,
  available,
  onChoose,
}: {
  start: ReviewStart;
  /** Whether the person may read the page's stored file; otherwise only a note is shown. */
  available: boolean;
  /** The page the frame shows: its file in the version. */
  path: string;
  onChoose(target: TextTarget): void;
}) {
  const t = useT();
  const { api } = useDashboard();
  const labels = useDiffLabels();
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("");
  const page = useRef<{ path: string; doc: AnchorDocument } | null>(null);

  /** The stored page's text model, read page by page up to the planners' HTML bound. */
  const load = async (): Promise<AnchorDocument> => {
    if (page.current?.path === path) return page.current.doc;
    let html = "";
    let offset: number | null = 0;
    while (offset !== null) {
      const part = await api.suggestions.pageContent(start.artifactId, path, offset);
      if (!part.contentType.startsWith("text/html")) throw new NotSearchable();
      html += part.content;
      if (part.size > PLAN_LIMITS.htmlBytes) throw new NotSearchable();
      offset = part.nextOffset;
    }
    const doc = pageDocument(html);
    page.current = { path, doc };
    return doc;
  };

  const search = useMutation({
    mutationFn: async (text: string) => {
      const doc = await load();
      return { doc, matches: findMatches(doc, text) };
    },
    onSuccess: ({ matches }) => setStatus(t("suggest.search.found", { count: matches.length })),
    onError: (error) => {
      if (error instanceof NotSearchable) setStatus(t("suggest.search.unavailable"));
    },
  });
  const choose = useMutation({
    mutationFn: async (match: TextMatch) => {
      const doc = search.data?.doc;
      return doc ? targetOf(doc, match, path) : null;
    },
    onSuccess: (target) => {
      if (target) onChoose(target);
      else setStatus(t("suggest.search.refused"));
    },
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (query.trim() !== "") search.mutate(query);
  };

  return (
    <section aria-labelledby="text-search-heading" className="flex flex-col gap-2">
      <h3 id="text-search-heading" className="text-base font-semibold">
        {t("suggest.search.heading")}
      </h3>
      {available ? null : <p className="text-sm">{t("suggest.search.ownerOnly")}</p>}
      {available ? (
        <>
          <p className="text-sm text-text-muted">{t("suggest.search.hint")}</p>
          <search aria-labelledby="text-search-heading">
            <form onSubmit={submit} className="flex flex-col gap-2">
              <TextInput
                label={t("suggest.search.query")}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
              <div>
                <Button
                  type="submit"
                  size="sm"
                  icon={<Search className="size-4" />}
                  busy={search.isPending}
                >
                  {t("suggest.search.find")}
                </Button>
              </div>
            </form>
          </search>
          <LiveRegion message={status} />
          {search.isError && !(search.error instanceof NotSearchable) ? (
            <ActionError error={search.error} />
          ) : null}
          {search.error instanceof NotSearchable ? (
            <p className="text-sm">{t("suggest.search.unavailable")}</p>
          ) : null}
          {search.data ? (
            search.data.matches.length === 0 ? (
              <p className="text-sm">{t("suggest.search.none")}</p>
            ) : (
              <ol aria-label={t("suggest.search.results")} className="flex flex-col gap-2">
                {search.data.matches.map((match, index) => (
                  <li key={`${match.start}:${match.end}`} className="flex flex-col gap-1 text-sm">
                    <p>
                      <TypedText
                        tokens={tokens(match.before)}
                        characterLabel={labels.character}
                        empty=""
                      />
                      <mark>
                        <TypedText
                          tokens={tokens(match.text)}
                          characterLabel={labels.character}
                          empty=""
                        />
                      </mark>
                      <TypedText
                        tokens={tokens(match.after)}
                        characterLabel={labels.character}
                        empty=""
                      />
                    </p>
                    <div>
                      <Button
                        size="sm"
                        busy={choose.isPending}
                        onClick={() => choose.mutate(match)}
                      >
                        {t("suggest.search.choose", { number: index + 1 })}
                      </Button>
                    </div>
                  </li>
                ))}
              </ol>
            )
          ) : null}
        </>
      ) : null}
    </section>
  );
}
