// The sidebar's "Suggest a text change" (decision 0027, "Suggesting"): for people who cannot
// select text in the frame, a search over the page's shown text that opens the same editor on a
// match. The text comes from the API (`GET .../page-text`, to whoever may suggest), never from
// the frame.
import type { NormalizedText } from "@portifact/anchors";
import type { ReviewStart } from "@portifact/contracts";
import { tokens } from "@portifact/domain/suggestion-display";
import { Button, LiveRegion, TextInput, TypedText } from "@portifact/ui";
import { useMutation } from "@tanstack/react-query";
import { Search } from "lucide-react";
import { type FormEvent, useRef, useState } from "react";
import { useDashboard, useT } from "../context.tsx";
import type { TextTarget } from "./suggest-session.ts";
import { useDiffLabels } from "./suggestions.tsx";
import { findMatches, pageText, type TextMatch, targetOf } from "./text-search.ts";
import { ActionError } from "./thread-card.tsx";

/**
 * Thrown when the server has no text for the page (over the planning limits, not a page, no
 * readable rendering) or the page is of a newer version than the frame shows.
 */
class NotSearchable extends Error {
  constructor(readonly stale: boolean) {
    super(stale ? "stale" : "unavailable");
  }
}

export function TextSearchPanel({
  start,
  path,
  onChoose,
}: {
  start: ReviewStart;
  /** The page the frame shows: its file in the version. */
  path: string;
  onChoose(target: TextTarget): void;
}) {
  const t = useT();
  const { api } = useDashboard();
  const labels = useDiffLabels();
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("");
  // One read per page: each read counts in the planning windows on the server.
  const page = useRef<{ path: string; text: NormalizedText } | null>(null);

  /** The page's shown text, of the version the frame shows. */
  const load = async (): Promise<NormalizedText> => {
    if (page.current?.path === path) return page.current.text;
    const answer = await api.suggestions.pageText(start.artifactId, path);
    if (answer.state !== "ready") throw new NotSearchable(false);
    // A target must name the text the frame shows; a newer version is searched after a reload.
    if (answer.versionId !== start.versionId) throw new NotSearchable(true);
    const text = pageText(answer.text);
    page.current = { path, text };
    return text;
  };

  const search = useMutation({
    mutationFn: async (text: string) => {
      const page = await load();
      return { page, matches: findMatches(page, text) };
    },
    onSuccess: ({ matches }) => setStatus(t("suggest.search.found", { count: matches.length })),
    onError: (error) => {
      if (error instanceof NotSearchable) setStatus(notSearchable(error));
    },
  });
  const choose = useMutation({
    mutationFn: async (match: TextMatch) => {
      const page = search.data?.page;
      return page ? targetOf(page, match, path) : null;
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
  const notSearchable = (error: NotSearchable) =>
    t(error.stale ? "suggest.search.stale" : "suggest.search.unavailable");

  return (
    <section aria-labelledby="text-search-heading" className="flex flex-col gap-2">
      <h3 id="text-search-heading" className="text-base font-semibold">
        {t("suggest.search.heading")}
      </h3>
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
        <p className="text-sm">{notSearchable(search.error)}</p>
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
                  <Button size="sm" busy={choose.isPending} onClick={() => choose.mutate(match)}>
                    {t("suggest.search.choose", { number: index + 1 })}
                  </Button>
                </div>
              </li>
            ))}
          </ol>
        )
      ) : null}
    </section>
  );
}
