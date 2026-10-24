# Roles and permissions

Cadrel starts with one person, the **Owner**, and lets administrators build whatever role structure the studio needs. The shipped roles are sensible defaults, not a fixed list: every one of them can be edited, copied or deleted (except Owner).

Related: [ARCHITECTURE.md](ARCHITECTURE.md) (vault, Cloudflare), [PLAN.md](PLAN.md) (milestones).

## 1. Principles

1. **Enforced on the server.** The Worker checks every request. The desktop app hides what you cannot do, but hiding is convenience, not security. File downloads and uploads use short-lived signed R2 URLs that are issued only after a permission check; the bucket is private.
2. **Additive and explainable.** Roles only grant. There are no per-person "deny" rules, so *why can she see this?* always has a traceable answer. Restriction comes from scope, confidential projects, and workflow state, which are all visible.
3. **Least privilege by default.** A new person has no role until one is assigned. A new capability, when a module adds one, is Owner-only until an admin places it.
4. **Governance cannot be handed on unless held.** Powers over who can do what (`people.*`, `roles.manage`, `teams.manage`, `studio.settings`, `security.policy`, `workflow.design`, `vault.force`, `confidential.access`, `audit.read`) can be granted only by someone who holds them. Ordinary content powers can be granted by anyone with `roles.manage`, so an Admin who only reads manuscripts can still make someone an Author. Nobody grants a role to themselves, and only an Owner creates or changes Owners.
5. **Everything is audited.** Role edits, assignments, invitations, force-releases of locks, and every read of finance and contract data go in an append-only log.

## 2. The model

```
Person ──┬── Assignment(role, scope, expires?) ──► Role ──► Capabilities
Team ────┘                                              (set of names like file.checkout)
                         │
                         ▼
 Scope:  studio ► IP ► series ► book ► folder/file     (an assignment applies to its scope and everything below)
```

- **Capability**: a named permission, `area.action` (`file.checkout`, `finance.read`, `canon.approve`). Each module declares its own in its manifest, so new modules extend the list without core changes.
- **Role**: a named set of capabilities, with a description. Roles are data, not code.
- **Assignment**: *this person (or team) has this role at this scope*, optionally until a date. A person can hold many assignments: Author on one series, Editor on another, Series Lead on a third.
- **Team**: a named group (Editors, Art, Launch crew). Assign a role to a team once, and membership decides who has it.
- **Scope**: studio, IP, series, book, or a single folder or file. The narrower the scope, the narrower the access. Freelancers and guests normally get a role scoped to one book or file, with an expiry.
- **Confidential**: any IP, series or book can be marked confidential. Studio-wide assignments no longer reach it. Only people assigned at or below that node, plus holders of `confidential.access` (Owner by default), can see it. Its existence is hidden from everyone else, and the assistant (MCP) is disabled on it by default.

### How a request is decided

`can(actor, capability, resource)` is one pure function used by the Worker, the desktop app and the tests:

1. Collect the actor's current assignments (direct and through teams), dropping expired ones.
2. Find assignments whose scope is the resource or an ancestor of it, and whose role contains the capability.
3. If the resource or an ancestor is confidential, keep only assignments at or below that confidential node (or the actor holding `confidential.access`).
4. Apply **workflow state**: the file's or record's current state may make it read-only or limit which transitions this role may perform.
5. For file edits the vault adds the **lock** rule on top: only the holder of a check-out can change that file, and `vault.force` is the only way to break the lock.
6. Return allow or deny **with the reason** (`allowed by Editor on Book 3 via team Editors`). The same function powers the admin **Explain access** tool.

## 3. Starting out

1. The Worker is deployed with a one-time **setup code** (a secret).
2. On first launch, **Create studio** asks for the code, the studio name and your name. You become the **Owner**, the code is destroyed, and the default roles are created.
3. You invite people (email invitation, or a link) and assign roles. Nothing else is needed to be productive: the defaults cover a working studio.
4. Anything beyond the defaults is done in **Settings → People & Roles** (below).

Before a server exists, the local vault runs the same model with you as the only Owner, so the role editor can be built and used from M1.

### Sign-in and invitations

- An admin enters an email address and picks a role and scope. The person gets an **invitation link**; opening it in Cadrel (custom `cadrel://` link or a code to paste) creates their account on that device.
- Afterwards, signing in on a new device sends a **one-time link** to their email (15 minutes, single use). A device then holds a refresh token for the session length, revocable by an admin or the person.
- Links are single-use random tokens stored hashed, rate-limited per address and per IP.
- Email needs a sender. Cloudflare Email Sending can do it, but it is in beta, needs the Workers Paid plan and a domain onboarded to Email Service. Until that exists, **an admin can copy the invitation link and send it themselves**, and the Owner's first sign-in uses the setup code and needs no email.

## 4. Default roles

Defaults are created as ordinary roles marked "default". Each has **Reset to default** (like MDEdit's project templates). When a later version adds a capability, a default role that has not been edited receives the sensible new capability automatically; an edited one does not, and the admin is shown a "new capabilities to review" list instead.

**Legend:** `M` manage (create, edit, configure) · `A` approve / decide · `W` write · `C` comment and respond only · `R` read · `—` none. "Own" roles (Author, Editor, Artist, Guest) apply within the books or files they are assigned; the others apply across the scope they are given (usually the studio).

| Area | Owner | Admin | Director | Series Lead | Author | Editor | Art Dir | Artist | Marketing | Analyst | Finance | Guest |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| People, teams, roles | M | M | R | — | — | — | — | — | — | — | — | — |
| Security policy, studio settings | M | M | — | — | — | — | — | — | — | — | — | — |
| Audit log | R | R | R | — | — | — | — | — | — | — | — | — |
| Force check-out (`vault.force`) | A | A | — | — | — | — | — | — | — | — | — | — |
| Confidential projects (`confidential.access`) | A | A | — | — | — | — | — | — | — | — | — | — |
| Catalogue: IP, series, books, editions | M | M | M | W | R | R | R | R | R | R | R | — |
| Workflow design (states, transitions) | M | M | M | — | — | — | — | — | — | — | — | — |
| Tasks and deadlines | M | M | M | M | W | W | M | W | M | W | W | W |
| Manuscripts | M | R | R | A | W | W | R | — | R | — | — | C |
| Editorial passes and queries | M | R | A | A | C | M | — | — | — | — | — | C |
| Canon / series bible | M | R | R | A | W | W | R | R | R | — | — | — |
| Assets, art, covers | M | R | A | A | C | R | M | W | R | R | — | C |
| Preflight | M | R | R | R | R | W | W | R | R | — | — | — |
| Launch and marketing | M | R | A | C | R | — | C | C | M | R | — | — |
| Market research | M | R | R | R | R | — | R | R | W | M | — | — |
| Sales (aggregates) | M | R | R | R | R | — | — | — | R | R | R | — |
| Royalties, payments, payouts | M | R | R | — | R | — | — | — | — | — | M | — |
| Contracts, credits, rights, revenue shares, costs | M | R | M | — | R | — | — | — | — | — | M | — |
| Assistant (MCP) | W | W | W | W | W | W | W | W | W | W | W | — |

Notes on the defaults:
- **Owner** holds every capability, including ones modules add later, and cannot be restricted. There must always be at least one Owner.
- **Admin** runs the studio's setup (people, roles, security, workflows, vault) and **can see everything**, including finance, contracts and confidential projects. It differs from Owner only in that it cannot create or change Owners and cannot be given more than the Owner holds. Because Admin reads all data, reads of finance and contract data are logged for admins too.
- **Author** sees royalties and agreements for their *own* books and contract only.
- **Guest** is the freelancer or beta-reader role: a scoped, expiring grant on specific books or files, no studio-wide visibility, no people directory, no assistant.
- Two things the matrix cannot show: **workflow state** can narrow any cell (a manuscript in *Approved* is read-only to Authors and Editors), and **data cards** can restrict individual metadata fields (for example only Marketing edits blurb and keywords).

## 5. Flexible by design: what admins can configure

**Settings → People & Roles**
- **Roles**: create, copy, rename, delete; edit capabilities in a grouped checklist (by module, with plain-language descriptions); see **who holds this role**.
- **Assignments**: person or team × role × scope × optional expiry. Bulk assign to a team.
- **Teams**: create, manage membership.
- **Explain access**: pick a person and a book or file; see exactly which assignment allows or blocks each action.
- **View as**: preview the app as a role or person (read-only) before assigning.
- **Capability review**: capabilities added by new modules or versions that no role yet contains.

**Settings → Security policy** (defaults in brackets)

| Setting | Default |
|---|---|
| Sign-in | **Decided:** email invitation and one-time sign-in link; no passwords. SSO can be added later |
| Second factor | Not part of email-link sign-in; the link proves control of the mailbox. A second factor (authenticator app) for Owner, Admin, Finance and Director is a later addition |
| Session length on a device | 14 days; revoke any device from People |
| Invitation and sign-in link lifetime | Invitation 7 days; each sign-in link 15 minutes, single use |
| Who may invite | Holders of `people.invite` (Owner, Admin) |
| Guest access | Allowed; expires after 90 days unless renewed; cannot invite anyone |
| Stale check-out | Warn the holder and the admin after 7 days; never released automatically |
| Force release | Needs `vault.force`, a typed reason, confirmation of the data-loss warning; notifies the holder; audited |
| Confidential projects | Optional per IP, series or book; assistant disabled on them |
| Assistant (MCP) | On for roles that have the capability; acts only with the signed-in person's permissions; writes are proposals |
| Local copies on departure | When access is removed, the app deletes cached read-only copies the next time it connects and moves any file with unsaved changes into a quarantine folder for the admin; it cannot recall files from a machine that never reconnects |
| Audit retention | Kept indefinitely |

## 6. Guardrails

- A person with `roles.manage` can grant any ordinary role, but only governance capabilities they hold themselves, and never to themselves. Unknown capabilities are refused.
- The last Owner cannot be removed, demoted or expired.
- Removing a capability from a role takes effect on the next request; there is no cached permission beyond a short token lifetime (minutes).
- Deleting a role needs it to be unassigned, or an explicit replacement role chosen.
- Reading finance, contract and revenue-share data is logged, not only writing it.
- Invitations, grants and role changes notify the person affected and are visible to Owners.

## 7. Data model (D1 and the desktop cache)

`person`, `team`, `team_member`, `role(id, studio_id, name, description, template_key, is_default, locked)`, `role_capability(role_id, capability)`, `assignment(id, subject_kind person | team, subject_id, role_id, scope_kind, scope_id, expires_at, granted_by, granted_at)`, `node.confidential`, `invite`, `device_session`, `policy(key, value)`, `audit(at, actor, action, target, detail)`, and `workflow_transition_role(transition_id, role_id)` so each transition says which roles may perform it.

## 8. Tests

- A table-driven matrix test: every default role × every capability × representative resources, checked against this document's table.
- Property tests: no sequence of admin actions lets a person gain a capability the granter lacked; the last Owner is protected; expired and removed assignments deny; adding a confidential flag never widens access.
- `explain()` and `can()` must agree for every case.
- Two-client scenarios against the Worker running locally (Miniflare): author vs editor, guest isolation, force release, revoked access.
