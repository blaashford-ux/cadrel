# Drive-scope spike (throwaway)

Question: with the narrow `drive.file` scope, do two OAuth clients in **one** Google Cloud project see each other's files?
(Option B assumes the Windows client and the Android client count as the same app.)

## Setup (about 10 minutes)
1. In Google Cloud Console create project **P1**; enable the **Google Drive API**; configure the OAuth consent screen (External, add yourself as a test user, scope `.../auth/drive.file`).
2. In P1 create two OAuth client IDs of type **TVs and Limited Input devices**: call them `a` and `b`.
3. Create a second project **P2** with the same setup and one client `control`.
4. Copy `clients.example.json` to `clients.json` (git-ignored) and fill in the IDs and secrets.

## Run (same Google account for all three)
```
node spike.mjs login a ; node spike.mjs login b ; node spike.mjs login control
node spike.mjs create a                 # a makes folder + chapter1.md; note the file id
node spike.mjs list a                   # sanity: a sees them
node spike.mjs list b                   # TEST 1: expect b to see them (same project)
node spike.mjs list control             # expect control NOT to see them (different project)
node spike.mjs token b                  # note the page token
node spike.mjs update a <fileId>        # a edits
node spike.mjs rename b <fileId> chapter-one.md   # TEST 3: b can rename a's file
node spike.mjs changes b <pageToken>    # TEST 2: b sees update + rename; md5Checksum present
node spike.mjs revisions b <fileId>     # revision history kept
```
Report which of `list b`, `rename b`, `update`/`changes` and `list control` behaved as expected. Do not commit `clients.json` or `tokens/`.
