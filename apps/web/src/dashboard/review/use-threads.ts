// Threads of the version under review, refreshed incrementally: the first load reads every page,
// later refreshes send the cursor and apply only what changed, and a change of mode or current
// version starts over. Bodies, quotes and names in threads are untrusted text; they are only
// ever rendered as text.
import type {
  AnnotationPage,
  AnnotationRole,
  AnnotationsState,
  AnnotationThreadView,
} from "@portifact/contracts";
import { type QueryClient, useQuery, useQueryClient } from "@tanstack/react-query";
import type { DashboardApi } from "../api.ts";
import { useDashboard } from "../context.tsx";
import { refreshOptions } from "../refresh.ts";

export interface ThreadsState {
  annotations: AnnotationsState;
  currentVersionId: string | null;
  role: AnnotationRole;
  /** Oldest first, so a thread keeps its number. */
  threads: AnnotationThreadView[];
  cursor: string;
}

export const threadsQuery = (artifactId: string) => ["annotations", artifactId] as const;

const byCreation = (a: AnnotationThreadView, b: AnnotationThreadView) =>
  a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);

export async function loadThreads(
  api: DashboardApi,
  artifactId: string,
  previous?: ThreadsState,
): Promise<ThreadsState> {
  const threads = new Map(previous?.threads.map((thread) => [thread.id, thread]));
  let cursor = previous?.cursor;
  let page: AnnotationPage;
  do {
    page = await api.listAnnotations(artifactId, cursor);
    if (
      previous &&
      (page.annotations !== previous.annotations ||
        page.currentVersionId !== previous.currentVersionId)
    ) {
      return loadThreads(api, artifactId);
    }
    for (const id of page.removed) threads.delete(id);
    for (const thread of page.threads) threads.set(thread.id, thread);
    cursor = page.cursor;
  } while (page.hasMore);
  return {
    annotations: page.annotations,
    currentVersionId: page.currentVersionId,
    role: page.role,
    threads: [...threads.values()].sort(byCreation),
    cursor: page.cursor,
  };
}

export function useThreads(artifactId: string) {
  const { api } = useDashboard();
  const queryClient = useQueryClient();
  return useQuery({
    queryKey: threadsQuery(artifactId),
    queryFn: () =>
      loadThreads(
        api,
        artifactId,
        queryClient.getQueryData<ThreadsState>(threadsQuery(artifactId)),
      ),
    ...refreshOptions,
  });
}

/** Applies a thread the API just returned, before the next refresh confirms it. */
export function applyThread(
  queryClient: QueryClient,
  artifactId: string,
  thread: AnnotationThreadView,
): void {
  queryClient.setQueryData<ThreadsState>(threadsQuery(artifactId), (state) =>
    state
      ? {
          ...state,
          threads: [...state.threads.filter((t) => t.id !== thread.id), thread].sort(byCreation),
        }
      : state,
  );
}

/** Drops a thread that was deleted. */
export function dropThread(queryClient: QueryClient, artifactId: string, threadId: string): void {
  queryClient.setQueryData<ThreadsState>(threadsQuery(artifactId), (state) =>
    state ? { ...state, threads: state.threads.filter((t) => t.id !== threadId) } : state,
  );
}
