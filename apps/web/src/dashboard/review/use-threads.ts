// Threads of the version under review, refreshed incrementally: the first load reads every page,
// later refreshes send the cursor and apply only what changed, and a change of mode, current
// version or the caller's comment scope (which threads they may see) starts over. The owner may ask for another version's threads or all of them; each
// choice is its own query. Bodies, quotes and names in threads are untrusted text; they are only
// ever rendered as text.
import type {
  AnnotationPage,
  AnnotationRole,
  AnnotationsState,
  AnnotationThreadView,
  AnnotationVersionFilter,
  CommentScope,
} from "@portifact/contracts";
import {
  keepPreviousData,
  type QueryClient,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import type { DashboardApi } from "../api.ts";
import { useDashboard } from "../context.tsx";
import { refreshOptions } from "../refresh.ts";

export interface ThreadsState {
  annotations: AnnotationsState;
  currentVersionId: string | null;
  role: AnnotationRole;
  /** Which threads the caller sees: all, or only their own and the owner's. */
  commentScope: CommentScope;
  /** Whether the visitor's next comment needs the human check, so the viewer can start it early. */
  humanCheck: boolean;
  /** Which version's threads these are: `current`, `all` or a version ID. */
  version: AnnotationVersionFilter;
  /** Oldest first, so a thread keeps its number. */
  threads: AnnotationThreadView[];
  cursor: string;
}

/**
 * Without `version`, the prefix of every version's query of the artifact, for invalidating and
 * updating them all at once.
 */
export const threadsQuery = (
  artifactId: string,
  version?: AnnotationVersionFilter,
  suggestions = false,
) =>
  version === undefined
    ? (["annotations", artifactId] as const)
    : suggestions
      ? (["annotations", artifactId, version, "suggestions"] as const)
      : (["annotations", artifactId, version] as const);

const byCreation = (a: AnnotationThreadView, b: AnnotationThreadView) =>
  a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);

export async function loadThreads(
  api: DashboardApi,
  artifactId: string,
  version: AnnotationVersionFilter = "current",
  previous?: ThreadsState,
  suggestions = false,
): Promise<ThreadsState> {
  const threads = new Map(previous?.threads.map((thread) => [thread.id, thread]));
  let cursor = previous?.cursor;
  let page: AnnotationPage;
  do {
    // With suggestions on, each thread also says its kind and carries its suggestion.
    page = suggestions
      ? await api.suggestions.listAnnotations(artifactId, cursor, version)
      : await api.listAnnotations(artifactId, cursor, version);
    if (
      previous &&
      (page.annotations !== previous.annotations ||
        page.currentVersionId !== previous.currentVersionId ||
        page.commentScope !== previous.commentScope)
    ) {
      return loadThreads(api, artifactId, version, undefined, suggestions);
    }
    for (const id of page.removed) threads.delete(id);
    for (const thread of page.threads) threads.set(thread.id, thread);
    cursor = page.cursor;
  } while (page.hasMore);
  return {
    annotations: page.annotations,
    currentVersionId: page.currentVersionId,
    role: page.role,
    commentScope: page.commentScope,
    humanCheck: page.humanCheck,
    version,
    threads: [...threads.values()].sort(byCreation),
    cursor: page.cursor,
  };
}

export function useThreads(
  artifactId: string,
  version: AnnotationVersionFilter = "current",
  enabled = true,
  suggestions = false,
) {
  const { api } = useDashboard();
  const queryClient = useQueryClient();
  const key = threadsQuery(artifactId, version, suggestions);
  return useQuery({
    queryKey: key,
    enabled,
    queryFn: () =>
      loadThreads(
        api,
        artifactId,
        version,
        queryClient.getQueryData<ThreadsState>(key),
        suggestions,
      ),
    // Another version's threads load behind the ones on screen, so the panel never empties.
    placeholderData: keepPreviousData,
    ...refreshOptions,
  });
}

/** Whether a thread belongs in the threads of `version`. */
function belongs(version: AnnotationVersionFilter, thread: AnnotationThreadView): boolean {
  if (version === "all") return true;
  if (version === "current") return thread.current;
  return thread.versionId === version;
}

/** Applies a thread the API just returned to every version's list it belongs in. */
export function applyThread(
  queryClient: QueryClient,
  artifactId: string,
  thread: AnnotationThreadView,
): void {
  queryClient.setQueriesData<ThreadsState>({ queryKey: threadsQuery(artifactId) }, (state) => {
    if (!state) return state;
    const old = state.threads.find((t) => t.id === thread.id);
    if (!old && !belongs(state.version, thread)) return state;
    // A reply or a resolution answers the plain thread view: a suggestion keeps its fields.
    const next =
      old && "kind" in old && !("kind" in thread) ? { ...withKind(old), ...thread } : thread;
    return {
      ...state,
      threads: [...state.threads.filter((t) => t.id !== thread.id), next].sort(byCreation),
    };
  });
}

/** Drops a thread that was deleted. */
export function dropThread(queryClient: QueryClient, artifactId: string, threadId: string): void {
  queryClient.setQueriesData<ThreadsState>({ queryKey: threadsQuery(artifactId) }, (state) =>
    state ? { ...state, threads: state.threads.filter((t) => t.id !== threadId) } : state,
  );
}

/** The suggestion fields of a thread listed with `?fields=suggestion`. */
function withKind(thread: AnnotationThreadView): Record<string, unknown> {
  const { kind, suggestion } = thread as AnnotationThreadView & {
    kind?: unknown;
    suggestion?: unknown;
  };
  return { kind, suggestion };
}
