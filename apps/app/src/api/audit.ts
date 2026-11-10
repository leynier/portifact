// GET /api/v1/audit (premium plan T10): the owner's audit log, newest first, for its admins when
// the owner's plan includes `audit`. `?workspace=<slug>` names a workspace; without it, the
// caller's personal space. Bearer tokens with `artifacts:read` may read it, like the access log:
// the service still requires the admin role, and events name members only by display name and
// opaque ID, never by email (decision 0003 keeps `credentials:manage` for minting credentials,
// which this does not). The MCP tool get_audit_log returns the same body.
import {
  AUDIT_EXPORT_CURSOR_HEADER,
  AuditExportQuery,
  type AuditFilters,
  AuditQuery,
} from "@portifact/contracts";
import { exportAuditLog, getAuditLog } from "@portifact/services";
import type { Hono } from "hono";
import type { Env } from "../env.ts";
import { ownerScope } from "../regions.ts";
import { error, type Guarded, workspaceParam } from "./http.ts";

/** The filters of a parsed query, without the paging fields. */
export function auditFilters(query: {
  kinds?: AuditFilters["kinds"];
  actor?: string | undefined;
  target?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
}): AuditFilters {
  return {
    ...(query.kinds ? { kinds: query.kinds } : {}),
    ...(query.actor ? { actor: query.actor } : {}),
    ...(query.target ? { target: query.target } : {}),
    ...(query.from ? { from: query.from } : {}),
    ...(query.to ? { to: query.to } : {}),
  };
}

export function auditRoutes(api: Hono<{ Bindings: Env }>, guarded: Guarded, now: () => number) {
  api.get(
    "/api/v1/audit",
    guarded("artifacts:read", async (c, userId) => {
      const workspace = workspaceParam(c);
      if (!workspace.ok) return error(c, "not_found", "Workspace not found.");
      const query = AuditQuery.safeParse({
        kind: c.req.queries("kind"),
        actor: c.req.query("actor"),
        target: c.req.query("target"),
        from: c.req.query("from"),
        to: c.req.query("to"),
        cursor: c.req.query("cursor"),
        limit: c.req.query("limit"),
      });
      if (!query.success) {
        return error(c, "invalid_input", "Invalid kind, actor, target, from, to, cursor or limit.");
      }
      const scope = await ownerScope(c.env, userId, workspace.slug);
      if (!scope.ok) return error(c, scope.code, scope.message);
      const result = await getAuditLog(scope.value.db, {
        actor: scope.value.actor,
        filters: auditFilters({ ...query.data, kinds: query.data.kind }),
        cursor: query.data.cursor,
        limit: query.data.limit,
        now: now(),
      });
      if (!result.ok) return error(c, result.code, result.message);
      return c.json(result.value);
    }),
  );

  // GET /api/v1/audit/export (premium plan E3, feature `auditExport`): the same events as a CSV
  // or JSON Lines download, streamed a page at a time. One response is one part of at most
  // `AUDIT_EXPORT.rowsPerDatabase` events per database; when more remain, the
  // `Portifact-Next-Cursor` header names the cursor of the next part, which the CLI and the
  // dashboard follow and append. Only the first part starts with the CSV header.
  api.get(
    "/api/v1/audit/export",
    guarded("artifacts:read", async (c, userId) => {
      const workspace = workspaceParam(c);
      if (!workspace.ok) return error(c, "not_found", "Workspace not found.");
      const query = AuditExportQuery.safeParse({
        format: c.req.query("format"),
        kind: c.req.queries("kind"),
        actor: c.req.query("actor"),
        target: c.req.query("target"),
        from: c.req.query("from"),
        to: c.req.query("to"),
        cursor: c.req.query("cursor"),
      });
      if (!query.success) {
        return error(
          c,
          "invalid_input",
          "Invalid format (csv or jsonl), kind, actor, target, from, to or cursor.",
        );
      }
      const scope = await ownerScope(c.env, userId, workspace.slug);
      if (!scope.ok) return error(c, scope.code, scope.message);
      const result = await exportAuditLog(scope.value.db, {
        actor: scope.value.actor,
        format: query.data.format,
        filters: auditFilters({ ...query.data, kinds: query.data.kind }),
        cursor: query.data.cursor,
        now: now(),
      });
      if (!result.ok) return error(c, result.code, result.message);
      const part = result.value;
      const lines = part.lines();
      const encoder = new TextEncoder();
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          const next = await lines.next();
          if (next.done) controller.close();
          else controller.enqueue(encoder.encode(next.value));
        },
        async cancel() {
          await lines.return(undefined);
        },
      });
      const headers = new Headers({
        "Content-Type": part.contentType,
        "Content-Disposition": `attachment; filename="${part.fileName}"`,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      });
      if (part.nextCursor !== null) headers.set(AUDIT_EXPORT_CURSOR_HEADER, part.nextCursor);
      return new Response(body, { status: 200, headers });
    }),
  );
}
