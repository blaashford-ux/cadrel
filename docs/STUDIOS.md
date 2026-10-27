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
4. **No Studio shows another's data.** A Studio that is not built or not connected shows an explanation on every page and hides Write's and Market's views.
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

## Not built yet

- **Scheduled backups**, and backing up Market's library (it has its own *Back up…*). Manual backup, restore and MDEdit import are built (Settings → Backup and import).
- **What a role may do.** Members have a role recorded and the Admin page is hidden from non-administrators, but the permission engine is not yet applied to a member's actions: the vault (check-out, sync of files between members) is M2. Until then a member's folders are their own copy.
- **Recovery code** and a second owner device: lose the owner's computer and you lose the owner key.
- **Folder rename follows Studio rename**, and **moving one Studio's folder** by itself (the Cadrel folder moves as a whole).
- **A Studio's name on the server.** The server knows an id, not a name.
- The provisioning code is tested against a stand-in for Cloudflare's API that runs the real Studio server; it has not been run against Cloudflare itself.
