# Studios

A **Studio** is an independent workspace: its own people, projects, notes, files and server, walled off from every other Studio. One person can own several and be invited into others. Nothing is shared between Studios, because the people in one may have no claim on what is in another.

## What a Studio is made of

| | Where | Holds |
|---|---|---|
| **Server** | the owner's own Cloudflare account | a Worker (the Studio's API), a D1 database, an R2 bucket. Names: `cadrel-studio-<id>` for all three. |
| **Data folder** | `%APPDATA%\Cadrel\studios\<id>\` on each computer | projects and notes (`studio.json`), the person's profile (`user\`), Write's and Market's own data (`write\`, `market\`), `admin.json` (the project templates), `settings.json`, `secrets\` |
| **Working folders** | `<Cadrel folder>\<Studio>\` (default `<home>\Cadrel`) | `Projects\`, `Write\`, `Market\` |

The Studio on this computer, **My Studio**, always exists and has no server: it is a Studio for one person, and the folders are all it has.

The Studio's folder name is its name when it was made and does not change if it is renamed, so nothing on disk has to move.

## The walls

1. **One Studio per run.** Cadrel opens one Studio's folders at start. Choosing another Studio from the Studio menu on Home restarts Cadrel into it, so no module, cache, sync, search index or AI server ever holds two Studios' data at once.
2. **Separate everything.** Each Studio has its own data folder, its own working folders, its own profile and templates, its own database and file bucket.
3. **The AI sees one Studio.** The server Claude or GPT launches is given `--root` (the Studio's Projects folder), `--studio` (its notes) and `--library` (its Market library), and with an explicit `--root` it does not fall back to any other place.
4. **No Studio shows another's data.** A Studio that is not built or not connected shows an explanation on every page and hides Write's and Market's views. The one thing a person can ask for across Studios is a copy of Market captures (Settings → *Market captures from another Studio*), which adds another Studio's captured pages to this Studio's library and changes nothing in the other.
5. **Cadrel connects only to Studios you own or were invited to.** The list only grows by building a Studio here or by accepting an invitation, and each entry is pinned to the owner's key fingerprint.

## Building a Studio (Admin → Studio Manager)

The Studio Manager is off until an administrator turns it on. **Create Studio** makes the record; **Provision** builds it from the owner's Cloudflare account ID and an API token with *Workers Scripts: Edit*, *D1: Edit* and *R2: Edit*:

1. Look for the account's workers.dev address (the owner must have chosen one once in the dashboard).
2. Find or create the D1 database; find or create the R2 bucket.
3. Upload the Studio server (bundled into the app as `studio-worker.mjs`), bound to the database and bucket, told its Studio id and the owner's **public key**; enable its workers.dev address.
4. Wait for `/v1/info` to answer with the owner's fingerprint.

Every step first looks for what an earlier try made, so pressing Provision again finishes a build that stopped and never makes anything twice. The owner's key pair is made before step 1 and kept (encrypted) so the same key is used on a retry.

**The token** is used for this and dropped. *Keep this token on this computer* stores it encrypted with the operating system's store (Electron `safeStorage`; DPAPI on Windows), only for upgrades, and **Forget it** deletes it. If the computer has no secure store the token is not kept.

**Upgrade** uploads the Worker again. It never goes backwards: a Studio whose schema or API is newer than the app's is left alone and the message says to update Cadrel.

### One Studio for every build

There is no development copy of a Studio. A development build (`-dev.N`) and a release talk to the same Studio instance and share the same registry (`studios.json` in the same Cadrel data folder). So the Worker's schema is only ever *added to*, the API changes only by adding, and `apiVersion` / `schemaVersion` (in `@cadrel/kernel`, reported by `/v1/info`) tell an older app when it must update. The release workflow no longer deploys a Worker.

## People: keys, not passwords

There are no passwords, no email and no Cloudflare credentials for anyone but the owner.

- The **owner's key** (Ed25519) is made when the Studio is built; the Worker holds the public half as `OWNER_KEY`.
- To **invite**, the owner picks a role (any but Owner) and an optional label. The Worker stores only a hash of a one-time code; the app shows the link `cadrel://join?s=<address>&c=<code>&f=<owner fingerprint>&n=<name>` once. It works once and expires after 7 days.
- The invitee **joins** by pasting the link: Cadrel asks the address for `/v1/info` and refuses unless the owner fingerprint matches the link; only then does it make a key pair on that computer and register the public key with the code.
- Every later request carries the key, a timestamp and a signature over method, path, time and body. The Worker refuses unsigned, stale (over 5 minutes) and replayed (a signature seen in the last 10 minutes) requests.
- The owner can see members and pending invitations, cancel an invitation and remove a member. A removed key is refused for good and cannot rejoin.

The protocol is `@cadrel/kernel` `studioProtocol`; the server is `@cadrel/worker` `studio.ts`.

## The records and the vault on the server

A built Studio can keep everything on its server: the people, roles and teams, the catalogue, tasks, sign-offs, decisions, the vault and the project tree. Then **everyone uses it there, the owner too**, and the server decides what each person may do.

- **How a Studio gets there.** A Studio you joined is always like this. A Studio you own is moved once: *Admin → Studio Manager → Move this Studio's records to its server*. It sends every record, the contents of the vault's files and the project tree, then restarts Cadrel into the Studio's server. Nothing is deleted on your computer (`records.db` stays as a copy); running it again starts over on the server. The Studio must be the one in use, and unsaved edits in Write must be saved first.
- **Who is who.** The server knows each person by their key. A person who joins becomes a person in the records, holding the role the invitation named. An invitation can limit that role to **one project** and to **a number of days**, which is how a freelance guest is given one book for a while. The owner is the person who held the Owner role when the records were moved.
- **The service over the wire.** `POST /v1/call` runs a call of the same service the app uses in-process (`catalogue`, `people`, `business`, `work`, `workflows` and four permission questions), as the person whose key signed the request, with the same permission check. The names are a list; nothing else can be reached. A refusal comes back as the same kind of error. `@cadrel/service` `VaultAs` and `wire` are shared by the Worker and the app.
- **The vault.** `POST /v1/vault` runs the vault's operations (`VAULT_STORE_METHODS` in `@cadrel/kernel`): add a file, check out, check in, undo, force release (needs `vault.force`), orphans, references and data cards. The lock is a row the database keeps unique, so two people cannot both hold a file. A file is a **manuscript** or an **asset** by its type and is governed by `manuscript.*` or `asset.*` on the project its data card names (or on the Studio when it names none), so a guest given one book sees that book's files and no others. A file a person may not read is reported as absent. Check-in is refused unless the version's contents are already in the file store.
- **Contents** are stored once by their SHA-256 in the Studio's R2 bucket (`PUT/GET /v1/blobs/<hash>`; a file over 95 MB is refused, the Worker's request limit). A copy is kept on each computer, so a version is fetched once. A hash is served only to someone who may read a file that has it.
- **Projects.** The owner's project tree is published to the server when it changes and every other person receives their own part of it (a role on a book shows that book and the series above it as a container). Members cannot change the tree from their computer; it is kept by the owner.
- **Offline.** When the server cannot be reached the Files page shows the last list it had, says so, and files you have checked out can still be edited; check-in, check-out and Get latest wait for the connection. A Studio that cannot be reached at start is tried again every minute.
- **Backup.** *Back up the server's records* saves every record, who the owner is and the project tree to one file; *Put back from a backup…* replaces the server's records with it. File contents are not in it: they stay in the file store, where no version is ever deleted. Whole-Studio backups (Settings) cover this computer's folders; for a server Studio the records in them are the server's, so use the records backup.
- **Shared captures.** The pages Market saves are public page source. *Settings → Captures shared with this Studio* sends the ones the Studio lacks, fetches the ones this computer lacks and reads them in with Market's own import. Append-only: a capture is never replaced or removed. Needs `market.capture` to send and `market.read` to fetch.
- **Version check.** A Studio whose API or schema is newer than this Cadrel is not opened; the message says to update.

## Not built yet

- **Scheduled backups**, and backing up Market's library (it has its own *Back up…*). Manual backup, restore and MDEdit import are built (Settings → Backup and import).
- **Everything a person does is checked on the server only for what goes through the server**: the service's calls, the vault, files and captures. Notes (`studio.json`'s notes), Write's own manuscripts folder and Market's library are still each computer's own, apart from the shared captures. The assistant (MCP server) opens a records file, so a Studio whose records are on the server has no record tools for the assistant yet.
- **Members changing projects.** Only the owner changes the project tree (create, rename, move, link, archive, stages); a member's attempt is refused with a sentence. A member moving a project between stages needs this and is not possible yet.
- **The server cannot be asked who is online**, tasks do not notify anyone, and there is no live update: a page shows the server's state when it is opened or refreshed.
- **Role dashboards.** Home and the Dashboard show what a person's role lets them read (a card a role may not see is left out), but there is no separate Author, Editor or Director dashboard.
- **The security policy page** (sign-in rules, who may invite) and **replicating the file store** to a second bucket.
- **A signed installer.** The release workflow signs when the repository has the `CSC_LINK` and `CSC_KEY_PASSWORD` secrets (a code-signing certificate); without them it builds an unsigned installer and says so. There is no certificate yet.
- **Updates from the Studio's server** (R2). Cadrel still updates from its GitHub releases.
- **Recovery code** and a second owner device: lose the owner's computer and you lose the owner key.
- **Folder rename follows Studio rename**, and **moving one Studio's folder** by itself (the Cadrel folder moves as a whole).
- **A Studio's name on the server.** The server knows an id, not a name.
- The provisioning code and everything on this page is tested against a stand-in for Cloudflare's API that runs the real Studio server (with SQLite behind D1 and a map behind R2); it has not been run against Cloudflare itself. D1 and R2 differ from the stand-in in limits (batch size, request size, time per request) that a large Studio could meet.
