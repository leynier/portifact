# 0020 Workspace request policies

- Status: accepted for the mechanism and the network allowlists; the maximum session age and the allowed OAuth clients are designed here and ship in a follow-up
- Date: 2026-11-11
- Feature: premium plan E4, second half (`policies` in `PLANS`, Enterprise), after [decision 0015](0015-workspace-policies.md)

## Question

Decision 0015's policies bind what a request changes. An organization also wants to bind how a request reaches its workspace: only from its networks, only with a recent sign-in, only through the clients it trusts. Every interface acts on a workspace (dashboard, `/api/v1`, MCP, the CLI, service tokens, the artifact origin), so where is the one place such a rule is applied, what does it know about the request, how does the content Worker apply it without a D1 read per delivery request, how does a refusal look, and how do admins avoid locking themselves out?

## Scope of this change

This change delivers the mechanism (the request context and the choke point) and the first request policy end to end: network allowlists for people and for service tokens, in the app Worker, the content Worker, the dashboard, the CLI and MCP, the operator's escape hatch and restores. The maximum session age and the allowed OAuth clients need facts the mechanism can carry but that are not wired yet (when the caller authenticated, through which client); they are designed in "Next" and ship separately, because all three at once would not have been one reviewable pull request.

## Decision in short

- **One choke point.** The role is decided only in `actorOn` (`packages/services/src/actors.ts`), and every other entry (`resolveActor`, `authorizeOn`, `authorizeUploadOn`, `actorAndPlanOn`, `resolveOwnerScope`, `scoped`) goes through it. The request policies are applied there, after the membership (or the service token's row) is found and before an actor is returned, with the policy that already comes in the membership's own query (`Actor.policy`): no read is added.
- **The request context travels with the database handle.** `GlobalDb.request` (`packages/db/src/regions.ts`) is a required field of the type: a `RequestContext` (`packages/contracts/src/request-context.ts`), either `{ kind: "request", ip }` or `{ kind: "background" }`. Each Worker builds it once per request at its entry (`withRequestContext(env, requestContextOf(request))`: the app Worker in its first middleware, the content Worker in `route`), and every handle `regionsFromEnv` builds for that request carries it; a `RegionalDb` carries its `global`. The jobs Worker and the operator tool build `BACKGROUND`. A handle built without one gets `UNKNOWN_REQUEST` (`ip: null`), which every network allowlist refuses: forgetting fails closed.
- **No use case can ignore a refusal.** `actorOn` returns `Result<Actor | null>`: `ok(null)` for no role, `policy_refused` when a request policy refuses an existing role. Changing the return type made the compiler list every caller, and each decides explicitly: propagate the refusal (almost all), or treat it as no role where the answer can only be narrower (the account export, a custom domain claim's owner check). A job's re-checks run in the background, which is never bound.
- **Guard test.** `scripts/request-context.test.ts` checks what types cannot: each Worker entry builds its context from what it answers (the app and content Workers from `requestContextOf`, the jobs Worker and the operator `BACKGROUND`), no file of the app or content Worker names `BACKGROUND`, no adapter builds its own `globalDb(`, both actor paths in `actors.ts` pass through the policy check, and only `actors.ts` (and the workspace list, which marks a blocked workspace) call `checkRequestPolicy`.

### Alternatives rejected

- **An extra parameter on every use case.** About 150 service signatures and every adapter would have changed, and a new use case could still pass a permissive default. The handle is already what every role decision needs, so binding the request to it gives the same guarantee with far less churn.
- **Checks in the adapters (a middleware per route or tool).** A new route, tool or service would have to remember them, and the rule would be reimplemented per interface, which AGENTS.md forbids.
- **Checks service by service.** Same problem, and each service would need the policy, which only `actorOn` reads for free.
- **Copying the bindings per request with a spread.** Some runtimes expose bindings that a spread drops (the app tests' assets binding did). The per-request object is a prototype view over the Worker's bindings (`Object.create`, `withBindings` to replace one), and caches keyed by the bindings object (one Better Auth instance per isolate) key on `baseEnv(env)`.

## The network allowlists

`WorkspacePolicy` gains `ipAllowlist` (people) and `tokenIpAllowlist` (service tokens), each null or 1 to 50 (`WORKSPACE_POLICIES.ipRanges`) IPv4 or IPv6 ranges. Policies stored before them read as null (`.default(null)`), so no migration was needed.

### Parsing and matching (`packages/domain/src/ip-ranges.ts`)

- IPv4 is four decimal parts from 0 to 255 without leading zeros (`010` could mean octal). IPv6 is RFC 4291 text with one `::` and an optional IPv4 tail, never a zone ID (`%eth0` names an interface, not a network).
- A single address is stored as `/32` or `/128`. A prefix is a decimal length without leading zeros; `/0` (every address) is refused with its own message. Host bits are cleared (`192.0.2.77/24` is `192.0.2.0/24`), ranges inside another are dropped (CIDR ranges either nest or do not overlap), duplicates removed, and the list sorted, IPv4 first, IPv6 in RFC 5952 form.
- An IPv4-mapped IPv6 address is the IPv4 address it maps: a client arriving as `::ffff:192.0.2.1` matches `192.0.2.0/24`, and a range written that way is refused with a hint to write it as IPv4, so a network never has two spellings in a list.
- Table and property tests (fast-check) cover every rule, including idempotent normalization and that a range admits its addresses and not the one after it.

### Where the address comes from

Only `CF-Connecting-IP` as Cloudflare sets it (`requestContextOf`). No other header is read, and a client cannot set this one in production because the edge overwrites it. Missing or unreadable is `null`, which no allowlist admits. The e2e stack has no edge, so its test-only Worker maps `x-e2e-client-ip` to `CF-Connecting-IP` (dropping a client's own); no product code reads that header.

### Who is bound, through what

| Caller                                                                                                      | App Worker (dashboard, `/api/v1`, MCP, the read entry)                                     | Content Worker                                                                                                        |
| ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| A member, any role, admins included                                                                         | `ipAllowlist`, on every role decision                                                      | `workspace` artifacts: on every request; their other modes: when the read or review session renews (60-second claims) |
| A service token                                                                                             | `tokenIpAllowlist` only; absent, tokens are not bound                                      | never reads through the content Worker                                                                                |
| Someone with no role (a listed reader, a domain reader who is not a member, a public visitor, a share link) | not bound: the policy is only checked for an existing role, so they learn nothing about it | not bound                                                                                                             |
| A member in their personal space                                                                            | never bound by a workspace's policy                                                        | never bound                                                                                                           |
| Jobs, scans, the operator                                                                                   | never bound (`BACKGROUND`): the policy applied to the request that asked for the work      | n/a                                                                                                                   |

Tokens have their own list because CI runners rarely share an office's networks: one list for both would either open the office list to a CI provider's ranges or break automation. People are bound once their list exists, tokens only when the admin sets theirs.

The modes on the content Worker follow who the reader is: `public` and share links are for people outside by definition; `workspace` readers are all members; `restricted` and `domain` readers are outsiders the workspace chose (named readers, a domain) plus members, and only members are bound. **A refused person reads nothing of the workspace through their account** except a `public` artifact, which reads as for anyone (`checkReadAccess`, `getViewerArtifact`). That includes an artifact where they are also a listed reader: the reader list names an address, and the account behind it is a member the policy binds.

### The content Worker

- **No added read.** The delivery lookup already joins the owner's plan when the region's database is the global one (`withPlan`); it now also left-joins the workspace and selects only `json_extract(policy, '$.ipAllowlist')`. With a separate regional database (the EU) the plan was already read from the global database into a per-isolate cache for a minute; that one statement now returns the plan and the allowlist together (`findDeliveryOwner`, `deliveryOwner`). The D1 call counts are unchanged: a warm request is compared with and without a list in `apps/content/test/workspace-modes.test.ts`, and the EU's pinned counts (cold 3 global and 2 EU, warm 0 and 2) still hold in `apps/content/test/two-regions.test.ts`.
- **The check** is `networkAdmits` (domain), in `serve` after authorization and before the traffic quota, so a refusal charges nothing: a signed-in reader (read or review session, never a share link) of a `workspace` artifact must come from the allowlist. The answer is a 403 page that names neither the artifact nor its content.
- **Other modes.** For `restricted` and `domain` the content Worker cannot tell a member from an outsider without a read, so members are bound where their session renews: `refreshReadSession` and `refreshReviewSession` call `checkReadAccess`, whose `actorOn` applies the policy to the renewing request's address. A refused member's session ends and they go to the app's read entry, which answers `/login?error=network_refused` (the login page explains it in the visitor's language).
- **Revocation delay.** One database (production today): immediate for `workspace` artifacts, within the 60-second claims for the other modes. A separate regional database: within the per-isolate cache's minute (`PLAN_TTL_MS`) for `workspace` artifacts, the claims' minute for the others. Lifting a list has the same delays.
- **Custom hosts and the viewer.** A custom host serves through the same lookup and `serve`, so the same rule applies. The viewer page is the app's: `getViewerArtifact` decides the role through `actorOn`, so a refused member is refused there (or reads a public artifact as anyone), and the frame's review session renews like a read session.

## Refusals

| Situation                                       | Answer                                                                                                                                                                                                                | Why                                                                                                                                                              |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A member (any role) outside the people list     | `policy_refused` (403, CLI exit 7): "This workspace's network policy only allows access from approved networks, and your address (x) is not on its list. Connect from an approved network, or ask a workspace admin." | They already know the workspace exists, and admins need a debuggable answer. The message names the policy and the caller's own address, never the allowed ranges |
| A service token outside its list                | `policy_refused` naming the request's address, saying to run it from an approved network or ask an admin to add it                                                                                                    | The same, for whoever runs the automation                                                                                                                        |
| No address could be read                        | `policy_refused` saying Portifact could not tell the network                                                                                                                                                          | Fail closed, with a reason                                                                                                                                       |
| Someone with no role                            | unchanged (`not_found`)                                                                                                                                                                                               | The policy is not evaluated for them; nothing is disclosed                                                                                                       |
| The read entry, or a session renewal sent there | `/login?error=network_refused`, a translated page naming neither the workspace nor the artifact                                                                                                                       | A browser navigation, not an API call                                                                                                                            |
| The content Worker, `workspace` artifact        | a 403 page naming the network policy only                                                                                                                                                                             | Nothing of the artifact                                                                                                                                          |

The workspace list keeps every workspace, also a blocked one: listing one's own workspaces is not acting on them. Each item carries `blocked`, decided from the policy already in the row (no read). The dashboard's shell shows one page for a blocked workspace ("Not reachable from this network") instead of failing list by list, with a link to the personal space; the other spaces keep working. `portifact workspaces` says when a workspace refuses this machine's network, and the `list_workspaces` description tells an agent that only the user can fix it.

### A security signal for admins

Refusals are not changes, so they are not audit events. A bounded, rate-limited "someone was refused" signal was considered and not built: most refusals come from the members' own other networks (travel, home, mobile), so it would be mostly noise; it would need addresses, which this feature never stores; and the refused person already gets a message telling them to ask an admin. If customers ask for it, it belongs with the audit log streaming work, as daily counts without addresses.

## Lock-out safety

- **Saving.** `checkPolicyKeepsCaller` refuses (`invalid_input`, in the preview too) a people list that does not admit the address the admin is saving from, naming it. The Policies page shows the admin their current address (`yourIp`, admins only, never stored). The token list cannot lock the dashboard out, so it is not checked.
- **The dashboard is never a disallowed client.** Only networks bind it, and the saving admin's network is always admitted at save time.
- **Who it binds.** The preview returns `networks: { members, tokens }`, the counts a list would bind, and the dashboard confirms before saving any new or changed list. Portifact keeps nobody's address, so it cannot say who is outside the networks; the dialog says so.
- **The escape hatch.** When every admin is outside the networks (an office moved, a VPN changed), `bun run --cwd apps/jobs operator clear-request-policies <slug|workspace-id> --confirm <slug>` lifts exactly the two allowlists and keeps every other policy (`clearRequestPolicies`), recorded as `policy.changed` by the operator, with counts. It never needs the plan: it only loosens.

## Races

A list saved while a request is between its role decision and its write binds from the next role decision: a write already past it finishes (a renewal, in the services test), and a request that decides the role again later (changing readers re-decides who takes part in a review) is refused inside the same request. The policy is global and read with the membership, so there is no window beyond the one request in flight, and no job or scan is needed: a network list changes no stored data.

## Plan, admins and reading

- Setting or tightening a list needs `policies` in the plan; widening (every current range still covered) or lifting never does, and a lapsed plan keeps the lists applying (decision 0015's rule).
- Only admins change them, only through the dashboard session (`/api/v1/workspaces/:slug/policies`); no bearer route, MCP tool or CLI command.
- Reading follows decision 0015 (the Policies page and the workspace list), but the ranges are shown only to admins (`shownPolicy`): every other member, and every token, gets `"hidden"` where a list exists (`WorkspacePolicyShown`), and `describePolicy` says "people only from approved networks" without the networks.

## Audit

`policy.changed` gains `ipRanges` and `tokenIpRanges`: how many ranges a list names after the change, or null when it is lifted. Never an address or a range: an IP is not allowed in audit details. The dashboard and the CLI show them as counts ("people only from 2 networks").

## Restore

The allowlists are part of the policy, so `export-policies` and `apply-policies` carry them with no change to the commands; an export written before them applies as no list. A restore of only the regional database does not touch them.

## What this protects against, and what it does not

- It refuses a member's or a token's requests from outside the listed networks, through every interface, with the address Cloudflare reports.
- It does not stop someone who reaches an approved network (a shared VPN, a compromised office machine), and it binds accounts and tokens, not what was already shared outside the workspace (public artifacts, share links, listed outsiders).
- MCP clients that call from their vendor's cloud (hosted connectors) present the vendor's addresses, not the user's: a people list refuses them unless the admin adds those networks. Desktop MCP clients and the CLI present the user's own network.
- IPv6 privacy addresses change often: allow the network's prefix (a /56 or /64), not one address.
- Nothing about the feature stores or logs an address: the lists are ranges an admin typed, and the request's address is compared in memory and shown back only to the person making the request. The legal pages need no change.

## Next

The mechanism carries the request; the two remaining policies need more facts in it, all from the server's own records:

- **Maximum session age** (`sessionMaxHours`, 1 to 720): `RequestContext` gains `authenticatedAt`. The dashboard session: Better Auth's `sessions.created_at` (a refreshed session keeps its row and its creation time; a rotated one is a new sign-in). An OAuth access token: the time of the grant it descends from, carried through refreshes, so refreshing never resets the clock. A read or review session: its `auth_session_id`'s creation, joined in the renewal's existing read. Single sign-on: the same session clock, no dependency on the provider. Service tokens are not bound. A refusal sends the dashboard to sign in again with `next` back to the page, and the API, CLI and MCP say that signing in again fixes it; it never ends or deletes a session.
- **Allowed OAuth clients** (`allowedClients`): `RequestContext` gains `client`, from the token's record, never the request: the dashboard session (always allowed), the first-party CLI client, or a dynamically registered MCP client. Dynamically registered client IDs and names are self-asserted, so the honest controls are categories (allow the CLI, allow MCP clients) and, at most, specific registered IDs an admin picks from those its members actually authorized, shown as untrusted names. The dashboard copy must say that a dynamically registered client can call itself anything.
