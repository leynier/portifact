// The space the dashboard shows (premium plan T1): the personal space, or a workspace named by
// `?workspace=<slug>` in the URL, the same parameter the API's owner-scoped routes take. The root
// route validates it and keeps it on every link (`retainSearchParams`), so a reload or a shared
// link opens the same space; a slug the user is not a member of shows the missing page, exactly
// like an unknown one. The role comes from `GET /api/v1/workspaces`; it only decides what the
// screens offer, and the API stays the authority.
import {
  type OwnerView,
  type RequestRefusal,
  type RoleAction,
  type WorkspacePolicyShown,
  type WorkspaceRole,
  WorkspaceSlug,
  type WorkspaceView,
} from "@portifact/contracts";
import { roleAllows } from "@portifact/domain";
import { useQuery } from "@tanstack/react-query";
import { useSearch } from "@tanstack/react-router";
import { useDashboard } from "./context.tsx";
import type { MessageId } from "./i18n/en.ts";
import { refreshOptions } from "./refresh.ts";

export const WORKSPACES_QUERY = ["workspaces"] as const;

/** The search parameter every dashboard route takes. */
export interface SpaceSearch {
  workspace?: string | undefined;
}

/** The root route's search: a valid slug, or nothing for the personal space. */
export function parseSpaceSearch(search: Record<string, unknown>): SpaceSearch {
  const parsed = WorkspaceSlug.safeParse(search.workspace);
  return parsed.success ? { workspace: parsed.data } : {};
}

export type Space =
  | { kind: "personal"; slug: undefined; role: WorkspaceRole }
  | {
      kind: "workspace";
      slug: string;
      name: string;
      role: WorkspaceRole;
      /** Its request policies refuse this browser's network (decision 0020). */
      blocked?: boolean;
      /** Which one refuses it: the network, or a sign-in too old (decision 0021). */
      blockedBy?: RequestRefusal | null;
    };

export const PERSONAL: Space = { kind: "personal", slug: undefined, role: "admin" };

export type SpaceState =
  | { status: "loading" }
  | { status: "missing"; slug: string }
  | { status: "ready"; space: Space; workspaces: WorkspaceView[] };

/** The user's workspaces and roles, refreshed like the other lists. */
export function useWorkspaces() {
  const { api } = useDashboard();
  return useQuery({
    queryKey: WORKSPACES_QUERY,
    queryFn: () => api.workspaces(),
    ...refreshOptions,
  });
}

/** The slug in the URL, or undefined for the personal space. */
export function useSpaceSlug(): string | undefined {
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  return parseSpaceSearch(search).workspace;
}

/**
 * The space the URL names. The personal space needs no request; a workspace waits for the list
 * and is missing when the user is not in it (or the list cannot be loaded, which then says so
 * where the list is shown).
 */
export function useSpace(): SpaceState {
  const slug = useSpaceSlug();
  const workspaces = useWorkspaces();
  const items = workspaces.data?.items ?? [];
  if (slug === undefined) return { status: "ready", space: PERSONAL, workspaces: items };
  if (!workspaces.data)
    return workspaces.isError ? { status: "missing", slug } : { status: "loading" };
  const found = items.find((item) => item.slug === slug);
  if (!found) return { status: "missing", slug };
  return {
    status: "ready",
    space: {
      kind: "workspace",
      slug: found.slug,
      name: found.name,
      role: found.role,
      blocked: found.blocked,
      blockedBy: found.blockedBy,
    },
    workspaces: items,
  };
}

/** The space once known; screens inside the shell only render when it is. */
export function useReadySpace(): Space {
  const state = useSpace();
  return state.status === "ready" ? state.space : PERSONAL;
}

/**
 * The policies of the workspace that owns an artifact (decision 0015), from the workspace list;
 * undefined for a personal artifact. They only decide what the screens offer and explain.
 */
export function useOwnerPolicy(owner: OwnerView): WorkspacePolicyShown | undefined {
  const workspaces = useWorkspaces();
  if (owner.kind !== "workspace") return undefined;
  return workspaces.data?.items.find((item) => item.slug === owner.slug)?.policy;
}

/** Whether the role in the space allows the action; the API decides again. */
export function spaceCan(space: Pick<Space, "role">, action: RoleAction): boolean {
  return roleAllows(space.role, action);
}

/** The name of a role, for lists and the switcher. */
export const ROLE_LABELS: Record<WorkspaceRole, MessageId> = {
  admin: "role.admin",
  editor: "role.editor",
  member: "role.member",
};
