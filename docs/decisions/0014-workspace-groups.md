# 0014 Workspace groups

- Status: accepted
- Date: 2026-11-10
- Feature: premium plan T3 (`workspaces` in `PLANS`, Team and above; no new plan feature)

## Question

A `restricted` artifact lists the people who may read it by email address. A team wants to share an artifact with "Design" or "Legal" without typing every address, and without opening it to the whole workspace (`workspace` mode, [decision 0010](0010-workspace-access-modes.md)). How are groups modelled across the global and regional databases, who manages them, how does a group admit a reader, how does a group carry a comment visibility exception next to reader rows, how fast does removal take effect, and what keeps a restore from bringing a removed member back?

## Decision in short

- A group is a named set of members of one workspace (`workspace_groups`, `workspace_group_members`, both global, next to `workspace_members`). Names are one line of 1 to 80 characters, unique in the workspace without regard to ASCII case. Caps: 50 groups per workspace, 500 members per group, 20 groups per artifact (`WORKSPACE_GROUPS` in contracts).
- Only a workspace's admins manage groups (role action `members`), only through the dashboard session. Editors (and a service token with `artifacts:share`) list group IDs, names and member counts, never members, through `GET /api/v1/workspaces/:slug/groups` (`artifacts:read`), MCP `list_groups` and `portifact workspaces groups`. Members see nothing of groups.
- A `restricted` artifact of the workspace lists groups (`artifact_groups`, regional, with the artifact) through the existing access update (`addGroups`, `removeGroups`, `groupCommentVisibility`), by the owner side (`access` action), which bumps `policyGeneration` like reader changes. A member of a listed group reads it exactly as a listed reader does. Groups never apply to personal artifacts or to another workspace's artifacts, and a transfer drops them.
- Comment visibility: a group carries the same exception a reader row does (`null`, `all`, `own`). The reader row's exception wins; otherwise the widest scope among the listed groups the person is in, each group giving its exception or, without one, the artifact's setting; otherwise the setting.
- Revocation follows decision 0010: leaving a group, the group being deleted or the person leaving the workspace stops reading at the next 60-second claim renewal and refuses new sessions at once; removing a group from an artifact moves the generation and ends sessions on the next request.
- Plan: creating groups, adding members and adding a group to an artifact need `workspaces`; renaming, removing members, deleting groups, removing a group from an artifact and listing never do. With the feature gone, groups grant nothing (and carry no exceptions) until it returns: never wider.
- Restores: deleting a group writes a `workspace_group` tombstone, removing a membership (one by one, or every membership of someone leaving or removed from the workspace) writes a `workspace_group_member` tombstone per row; `applyTombstones` deletes the rows they name. Those two kinds of tombstone are pruned after the 30-day D1 Time Travel window (`pruneGroupTombstones`), since no restore can reach further back.

## Design

### Data and regions

`workspace_groups` (ID `wg_` and 32 hex characters, workspace, name, created, updated) and `workspace_group_members` (ID `wgm_`, group, workspace, user, created) live in the global database. Two composite foreign keys tie a membership to its workspace: `(workspace_id, group_id)` to the group and `(workspace_id, user_id)` to `workspace_members`. So the database itself refuses a member of another workspace or a non-member, and leaving or being removed from the workspace, or deleting the account, removes the person from its groups by cascade in the same statement. Deleting the workspace removes its groups by cascade.

`artifact_groups` (artifact, group, comment exception, created, `checked_at`) lives with the artifact in its region and cascades from it. It cannot reference the global group. Consequences, which [decision 0005](0005-regions.md) requires anyway (no batch spans two databases):

- Adding a group checks, after authorization, that the group exists in the artifact owner's workspace (one global read), then writes the regional row in the access update's batch, on the generation and owner it read. A group deleted between the check and the write leaves a row that grants nothing.
- A row whose group is gone counts toward no cap and is not shown; the next change to the artifact's groups deletes it in its own batch.
- Deleting a group cannot delete the regional rows in its batch. Those rows grant nothing, because reading asks the global database which listed groups the viewer belongs to and a deleted group has no members. A bounded maintenance scan (`pruneArtifactGroups`, every 15 minutes, before the approval re-check that runs last) takes up to 500 rows least recently checked, asks the global database which of their groups still exist in the artifact owner's workspace, deletes the others and marks the rest checked, so every row is reached in turn. The access view leaves a deleted group out at once.

### Who reads

`canRead` (`packages/domain/src/access.ts`) gets `groups`: whether the owner's plan includes `workspaces` and the listed groups the viewer belongs to (`GroupMatch`, from `viewerGroups` in the services). In `restricted` mode it admits a viewer when one of those groups matched, the owner is a workspace and the viewer's actor is a member of it (the membership the role came from). Groups add nothing in the other modes: `public` and `authenticated` admit more already, `workspace` and `domain` admit every member already.

The read path asks for groups only when nothing else admitted the viewer: `checkReadAccess` calls `viewerGroups` only for a member of the artifact's workspace on a `restricted` artifact who is neither on the owner side nor on the reader list. That is one indexed regional read of the artifact's group rows and, only when it lists any, one indexed global read of the viewer's memberships among them. Delivery adds no read: the content Worker keeps its one lookup and the claims of read and review sessions, renewed every 60 seconds through `checkReadAccess`. The annotation services' `roleOf` reads the same for a member of the workspace (also in other modes, for the exceptions); the space's open feedback reads the caller's groups in the workspace once (one global read) and filters by them in its single query.

A service token never reads through a group (rules that need a person refuse it, [decision 0011](0011-service-tokens.md)).

### Comment visibility precedence

`commentScope(role, visibility, readerException, groupExceptions)`:

1. The owner side sees all.
2. A reader row with an exception wins: it is the most specific choice the owner side made for this person, and it can narrow as well as widen.
3. Otherwise, when the person belongs to listed groups, each group gives a scope (its exception, or the artifact's setting when it has none) and the widest wins. A person in two groups has been included in both on purpose; showing them less than one of the groups was opened to would make a group's `all` depend on unrelated memberships. Narrowing a person below their groups is still possible with a reader row (`own`).
4. Otherwise the artifact's setting.

The same rule is evaluated in SQL where writes and lists need it on live rows: `scopeGuard` (writes that name a thread) and the feedback listing's `scopeCondition` use `coalesce(reader exception, group scope, setting)`, the group scope computed by `groupScopeSql` over the artifact's live `artifact_groups` rows restricted to the caller's group IDs read when the request loaded. A table-driven test (`packages/services/test/workspace-groups.test.ts`, "comment visibility by group agrees on every read path") proves that the list, get by ID, export, a reply and the space's feedback agree for every combination.

### Revocation

| Change                             | New sessions | Open read and review sessions                  |
| ---------------------------------- | ------------ | ---------------------------------------------- |
| Removed from the group             | refused      | end at the next claim renewal (at most 60 s)   |
| Group deleted                      | refused      | end at the next claim renewal (at most 60 s)   |
| Left or removed from the workspace | refused      | end at the next claim renewal (at most 60 s)   |
| Plan lost `workspaces`             | refused      | end at the next claim renewal (at most 60 s)   |
| Group removed from the artifact    | refused      | end on the next request (the generation moved) |

Removing someone from a group or deleting a group does not bump any artifact's generation, for the reason 0010 gives for memberships and domains: a group belongs to the workspace, not to each artifact, and a write per artifact buys nothing over the 60-second renewal.

### Interfaces

| Operation                                     | Dashboard session | API bearer        | MCP                                                 | CLI                                       |
| --------------------------------------------- | ----------------- | ----------------- | --------------------------------------------------- | ----------------------------------------- |
| List IDs, names, counts                       | admins, editors   | `artifacts:read`  | `list_groups`                                       | `portifact workspaces groups <slug>`      |
| Group detail with members                     | admins            | refused           | none                                                | none                                      |
| Create, rename, delete, add or remove members | admins            | refused (403)     | none                                                | none                                      |
| Add or remove a group on an artifact          | owner side        | `artifacts:share` | `add_group`, `remove_group`                         | `portifact access group add` and `remove` |
| A group's comment exception                   | owner side        | `artifacts:share` | `set_comment_visibility` (`groupCommentVisibility`) | `portifact access group-comments`         |

Management stays session-only like members and invitations ([decision 0003](0003-credentials-scope.md) keeps account-level changes out of scopes): a group decides who reads, so an agent or a leaked token must not be able to add people to one. A service token lists groups only with `artifacts:share` (what using them takes) and never changes a group's comment exception, like reader exceptions. `getAccess` returns the artifact's groups (ID, current name, member count, exception) to the owner side, and to a token only with `artifacts:share`, like readers (`seesReaders`). The MCP tools and the skill tell agents to ask the user before adding a group, as for readers.

### Audit log

Global events, through `auditEvent` in each change's own batch on its own condition: `group.created`, `group.renamed`, `group.deleted` (target: the group) and `group.member_added`, `group.member_removed` (target: the member, detail `{ group: <ID> }`). The group's name is owner-chosen text: events store only its ID, and readers show the current name at display time (`group` in `AuditEventView`, null once deleted), like a service token's label. Changes to an artifact's groups are part of its `access.changed` event as counts (`groupsAdded`, `groupsRemoved`, `groupExceptions`), like readers: one access change is one event, in the regional batch that makes it. Memberships that go by cascade when someone leaves the workspace record nothing beyond `member.left` or `member.removed`.

### Approval reviews and content search

Approval reviews ([decision 0013](0013-approval-reviews.md)) ask the same access rules who may review: `participation` also admits a member of the owning workspace who is in a group the `restricted` artifact lists, with one regional read of the listed groups and one batched global read of the memberships of the workspace's members among the addresses (an address outside the workspace never changes the reads or the answer). Removing a group from the artifact drops the reviewers it admitted in the access change's own batch (`approvalAccessStatements`), like removing a reader. Removing someone from a group, or deleting the group, is a global change, so `recheckApprovalReviewers` drops them on its next pass, like losing workspace membership; its per-request budget counts the two group reads (10 calls a request). Who sees other reviewers' entries follows `commentScope`, so a group's comment exception applies there too.

Content search is owner-side only, so groups do not apply to it.

### Webhooks

`artifact.access_changed` already fires when the generation moves, which adding or removing groups does. Nothing else.

## Alternatives rejected

- **Groups as reader rows (expanding a group into addresses).** Copies addresses into every artifact, goes stale when the group changes and needs a write per artifact for every membership change.
- **Narrowest exception wins among groups.** Makes adding someone to an `own` group silently hide threads another group was opened to; a reader row with `own` already narrows one person deliberately.
- **Group management through MCP or a bearer route.** Adding a person to a group widens what they read across every artifact that lists it; it stays with the admins' session.
- **A foreign key from `artifact_groups` to the group.** Impossible across regions; the global membership check plus the scan gives the same guarantee for reading.
- **Bumping every listing artifact's generation when a group changes.** A write per artifact for no gain over the renewal.

## Open risks

- **A group's members are the admins' responsibility.** An admin who adds the wrong member widens every artifact that lists the group at once; the audit log records it.
- **Stale rows.** A deleted group's regional rows linger until the scan reaches them (bounded, every 15 minutes, 500 rows per run); they grant nothing meanwhile.
- **Restore of the regional database alone.** It can bring back an artifact's group rows removed after the backup, like reader rows; groups and memberships come from the global database, whose tombstones keep deleted groups and removed memberships gone, so a rewound row can admit only someone still in the group.
- **Privacy.** Admins see each group's members; editors see names and counts. The account export lists the groups the account is in (names and when it was added), never the other members. See [legal.md](../legal.md).
