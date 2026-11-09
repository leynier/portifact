// Threads of the version under review, refreshed incrementally: the first load reads every page,
// later refreshes send the cursor and apply only what changed, and a change of mode or current
// version starts over. The owner may ask for another version's threads or all of them; each
// choice is its own query. Bodies, quotes and names in threads are untrusted text; they are only
// ever rendered as text.
import type {
  AnnotationPage,
  AnnotationRole,
  AnnotationsState,
  AnnotationThreadView,
  AnnotationVersionFilter,
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
export const threadsQuery = (artifactId: string, version?: AnnotationVersionFilter) =>
  version === undefined
    ? (["annotations", artifactId] as const)
    : (["annotations", artifactId, version] as const);

const byCreation = (a: AnnotationThreadView, b: AnnotationThreadView) =>
  a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);

export async function loadThreads(
  api: DashboardApi,
  artifactId: string,
  version: AnnotationVersionFilter = "current",
  previous?: ThreadsState,
): Promise<ThreadsState> {
  const threads = new Map(previous?.threads.map((thread) => [thread.id, thread]));
  let cursor = previous?.cursor;
  let page: AnnotationPage;
  do {
    page = await api.listAnnotations(artifactId, cursor, version);
    if (
      previous &&
      (page.annotations !== previous.annotations ||
        page.currentVersionId !== previous.currentVersionId)
    ) {
      return loadThreads(api, artifactId, version);
    }
    for (const id of page.removed) threads.delete(id);
    for (const thread of page.threads) threads.set(thread.id, thread);
    cursor = page.cursor;
  } while (page.hasMore);
  return {
    annotations: page.annotations,
    currentVersionId: page.currentVersionId,
    role: page.role,
    version,
    threads: [...threads.values()].sort(byCreation),
    cursor: page.cursor,
  };
}

export function useThreads(
  artifactId: string,
  version: AnnotationVersionFilter = "current",
  enabled = true,
) {
  const { api } = useDashboard();
  const queryClient = useQueryClient();
  return useQuery({
    queryKey: threadsQuery(artifactId, version),
    enabled,
    queryFn: () =>
      loadThreads(
        api,
        artifactId,
        version,
        queryClient.getQueryData<ThreadsState>(threadsQuery(artifactId, version)),
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
    const known = state.threads.some((t) => t.id === thread.id);
    if (!known && !belongs(state.version, thread)) return state;
    return {
      ...state,
      threads: [...state.threads.filter((t) => t.id !== thread.id), thread].sort(byCreation),
    };
  });
}

/** Drops a thread that was deleted. */
export function dropThread(queryClient: QueryClient, artifactId: string, threadId: string): void {
  queryClient.setQueriesData<ThreadsState>({ queryKey: threadsQuery(artifactId) }, (state) =>
    state ? { ...state, threads: state.threads.filter((t) => t.id !== threadId) } : state,
  );
}
