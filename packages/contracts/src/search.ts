// Content search (premium plan T8, feature `contentSearch`, decision 0012): searching inside the
// text of a space's artifacts. The index holds the current version of each active artifact of an
// owner whose plan includes the feature; these are its caps and the shapes every interface
// shares (GET /api/v1/search, the MCP tool search_content, `portifact search`, the dashboard).
import { z } from "zod";
import { ArtifactListItem, ListQuery } from "./publishing.ts";

const KIB = 1024;
const MIB = 1024 * KIB;

export const SEARCH_LIMITS = {
  /** The longest query, in characters; longer input is refused at the boundary. */
  queryChars: 200,
  /**
   * Different words a query may hold, and characters a Chinese or Japanese run may hold (each is
   * one token of a phrase): each costs a doclist read, so more is refused, never cut.
   */
  queryTerms: 8,
  queryPhraseTokens: 16,
  /** Bytes read from R2 per file; a larger file is read up to here and marked partly indexed. */
  fileReadBytes: 2 * MIB,
  /** Text kept per file after extraction, in UTF-8 bytes. */
  fileTextBytes: 512 * KIB,
  /** Files indexed per version: Markdown and TXT documents have one, sites their HTML pages. */
  filesPerVersion: 200,
  /** Text kept per version, in UTF-8 bytes. */
  versionTextBytes: 4 * MIB,
  /** Text kept per owner over all its artifacts, in UTF-8 bytes. */
  ownerTextBytes: 32 * MIB,
  /**
   * What one `search_index` job reads from R2 at most, in bytes and in files: past either, the job
   * writes what it read and leaves the rest to a continuation job. The jobs Worker runs up to 10
   * queue messages per invocation one after another, so one invocation reads at most 80 MiB and
   * makes at most 400 R2 reads, under the 1,000 subrequests of an invocation.
   */
  jobReadBytes: 8 * MIB,
  jobFiles: 40,
  /** Jobs the scheduled scan writes per run (every 15 minutes). */
  scanJobs: 200,
  /** Indexed artifacts the lapsed-plan scan drops per run (their chunks go with them). */
  dropArtifacts: 100,
  /** Results per page, at most. */
  pageMax: 50,
  /** Results per page when a request names none. */
  pageDefault: 20,
  /** Searches per actor in one window, counted after authorization and the plan gate. */
  perWindow: 60,
  /** Searches per owner in one window, whoever acts: bounds the work one space puts on its region. */
  perOwnerWindow: 300,
  windowSeconds: 60,
} as const;

/** A search query as typed: plain words; quotes and operators are ordinary characters. */
export const SearchText = z.string().trim().min(1).max(SEARCH_LIMITS.queryChars);

/** Query of GET /api/v1/search; `workspace` is read like on GET /api/v1/artifacts. */
export const SearchQuery = ListQuery.extend({
  q: SearchText,
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(SEARCH_LIMITS.pageMax)
    .default(SEARCH_LIMITS.pageDefault),
});
export type SearchQuery = z.infer<typeof SearchQuery>;

/**
 * A highlighted part of a snippet: `[start, end)` in UTF-16 code units of `text`, as JavaScript
 * strings index them. Clients escape the text and mark the ranges; the server never sends HTML.
 */
export const SnippetRange = z.tuple([z.int().min(0), z.int().min(0)]);
export type SnippetRange = z.infer<typeof SnippetRange>;

export const SearchSnippet = z.object({
  /** Plain text around the match, from the indexed text; never HTML. */
  text: z.string(),
  highlights: z.array(SnippetRange),
});
export type SearchSnippet = z.infer<typeof SearchSnippet>;

export const SearchResult = z.object({
  artifact: ArtifactListItem,
  /** The file of the artifact that matches best, as the artifact's manifest names it. */
  path: z.string(),
  snippet: SearchSnippet,
  /** Some of the artifact's text was over a cap and is not searchable. */
  partial: z.boolean(),
});
export type SearchResult = z.infer<typeof SearchResult>;

export const SearchResults = z.object({
  /** One result per artifact, most recently updated first, like the artifact list. */
  items: z.array(SearchResult),
  /** Pass as `cursor` with the same query to get the next page; `null` on the last page. */
  nextCursor: z.string().nullable(),
});
export type SearchResults = z.infer<typeof SearchResults>;

/** Payload of a `search_index` job: the version to index and where to resume; the subject is the artifact. */
export const SearchIndexPayload = z.strictObject({
  versionId: z.string().min(1).max(100),
  /** The first file a continuation job reads; absent for the first job of a version. */
  from: z.int().min(1).optional(),
});
export type SearchIndexPayload = z.infer<typeof SearchIndexPayload>;
