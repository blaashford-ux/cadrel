# Milestone 9 — AI reviewers (API + MCP)

Status: **complete (0.6.0).** Open items are in AI-REVIEW.md and the notes below: nothing was tried against a real Claude Desktop, ChatGPT or a Windows install. Goal: Claude and GPT can read a project's chapters and leave **comments and suggestions** that appear in MDEdit's Notes panel exactly like a human reviewer's. Three editing passes (developmental, line, copy) are packaged as skills that know how to use it.

### Progress and changes from the first draft
* **Done:** `src/shared/agent/` (tools, flattening), merge-on-save in `src/shared/backend/reviews.ts`, `category`/`origin` fields, `mcp/` server, build to `dist-electron/mcp/mdedit-mcp.js`, setup guide in [AI-REVIEW.md](AI-REVIEW.md). Verified through a real stdio client.
* **Anchors live in the editor's plain text, not the Markdown.** `flattenMarkdown` reproduces it, and `src/renderer/flattenParity.test.ts` checks it against the real Milkdown parser (the one thing that differed, hard line breaks, is fixed). `read_chapter` therefore returns plain text and has no line numbers.
* **No `--mcp` flag in the app.** A standalone bundle run by Node avoids the single-instance lock and window startup. Running it with the installed `MDEdit.exe` and `ELECTRON_RUN_AS_NODE=1` (so users need no Node) is unverified; check it on Windows in phase 3 when the settings page generates the config.
* **`.mdedit/review` now syncs** between devices (merged note by note, `sync/rules.ts` class `notes`); it did not before 0.6.5, so AI notes stayed on the PC. Sharing for review has its own path.
* **Phase 3 done:** notes reload every 4 s (a read that began before one of the app's own saves is ignored); AI badge, topic chips, reviewer and topic filters; "Accept all" for one reviewer; **Notes → AI…** dialog with copy-ready settings and per-reviewer delete; the installer unpacks the server (`asarUnpack`) and runs it with `ELECTRON_RUN_AS_NODE`, which works from the built bundle (checked on Linux; confirm on a Windows install). Also fixed a style clash that stacked note cards sideways (`review-list` was also the export-settings list).
* **Phase 4 done:** three genre-neutral skills in `skills/` built from the author's existing developmental, line and copy editing skills (their craft criteria kept; the genre- and project-specific parts, such as LitRPG conventions, a fixed spelling variant and a fixed content scope, became "follow the author's style sheet and notes"). Each leaves notes through `add_notes` with its own `skill` tag, and has a chat fallback when the tools are missing. They are also served as MCP prompts. Added a `search_text` tool, because copy editing and continuity checks need to find every use of a name or term. **Not yet tried with a live model:** the skills' wording will want tuning after a real pass on a real chapter.
* **Phase 5 done:** `mcp/http.ts` (MCP over Streamable HTTP with sessions, so the client's name is known; REST at `/api`; `/openapi.json` for Custom GPT Actions), `mcp/rest.ts`, `electron/aiRemote.ts` (off by default, 127.0.0.1 only, random 192-bit bearer token kept in `ai-remote.json`), a switch and token controls in Notes → AI…, and a `--http` flag on the standalone server. Tested over real sockets. Found and fixed while testing: after an oversized upload the connection must be closed. **Not tried against the live services** (ChatGPT, Custom GPTs): whether they accept a bearer token for MCP connectors, and the tunnel steps, are unverified.
* **Phase 6 done:** README "Review with AI", changelog, version 0.6.0 (package.json and lockfile; not tagged or released).
* **AI Kit:** Notes → AI… → "Save files to Downloads" writes `MDEdit AI Kit/` (Claude Desktop `.mcpb` extension, skill zips and folders, the server, settings, GPT instruction files, README). Built by `src/shared/agent/kit.ts`; an integration test unpacks the `.mcpb` and starts the server from inside it. **Unverified in real apps:** that Claude Desktop accepts the `.mcpb` manifest (written to the 0.2 format from memory) and the skill upload zips; install both once and fix the manifest if it objects.
* **Skills sign with their own tag:** `pass` became an optional `skill`. No skill → "Claude" (`ai-claude`); a skill → "Claude · Line edit" (`ai-claude-line`); any label is accepted.
* **One server for Claude and GPT.** The AI's name comes from the connecting client; `ai-claude-*` and `ai-gpt-*` files stay separate.

## 1. Where we start

Review already exists (0.5.0) and is the whole foundation:

* Notes live in `<project>/.mdedit/review/<reviewerId>.json`, **one file per reviewer** (`src/shared/review/comments.ts`: `ReviewItem` = comment | suggestion, with a text `Anchor` of quote + prefix/suffix, status, replies).
* The app shows every reviewer's file together (`useReview.ts`), and accepting a suggestion edits the chapter (`applySuggestion`).
* Files are plain JSON, written atomically (`src/shared/backend/reviews.ts`), and the code is pure and runs on `FsPort`, so it is reusable outside Electron.

So an AI reviewer is just **another reviewer file** (`ai-claude-line.json`). Nothing about the data model has to change, and the AI never touches the manuscript: it can only add notes. You accept or reject them in the app.

## 2. Decision: folder access or go through MDEdit?

**Reading** can be either. **Writing must go through MDEdit's tool**, for two reasons: the AI can't be trusted to produce a valid anchor (the quote has to match the file byte for byte, with context), and it shouldn't have write access to the manuscript folder at all.

Recommendation: **give the AI the MDEdit tools for everything, and treat raw folder access as optional.** The tool's read side is better than a bare folder because it returns one chapter at a time (split on Heading 1 like the app), skips settings, exports and `.mdedit`, and returns the notes already on a chapter so the AI doesn't repeat them or argue with a note you've resolved.

A plain Claude project on claude.ai (web) cannot see a folder on your PC; project knowledge is a snapshot upload. So the realistic setups are:

| Client | Reaches the folder via | Works in this plan |
|---|---|---|
| Claude Desktop / Claude Code | local stdio MCP | **Yes (phase 2)** |
| GPT in a desktop agent, Codex CLI, OpenAI Agents SDK | local stdio MCP | **Yes (phase 2)** |
| ChatGPT app, claude.ai web | needs a remote HTTPS MCP server (a tunnel to your PC) | Phase 5, optional. Verify current connector support in the phase 0 spike. |
| Custom GPT Actions | REST API over HTTPS | Phase 5, optional |

## 3. Architecture

```
src/shared/agent/         tools as plain functions over FsPort (list, read, notes, add) — no MCP, no Electron
mcp/server.ts             MCP adapter: stdio first, Streamable HTTP later; same tools, same tests
electron/main.ts          `MDEdit.exe --mcp` starts the server (no Node install needed for the user)
skills/                   three Claude skills + portable instruction files for GPT
```

* **Standalone, app need not be open.** The server reads and writes the project folder directly. The app picks up new notes by watching `.mdedit/review` (phase 3).
* **One core, several doors.** Because the tools are plain functions, the HTTP/REST door in phase 5 is a thin wrapper, not a rewrite.
* **Scope:** the server is started with one Root Folder (default from MDEdit's `settings.json`) and refuses any path outside it.
* **Phone:** not applicable; the server runs on the PC. Notes the AI adds still sync to the phone through the existing project sync, if `.mdedit/review` is syncable (to verify, see risks).

## 4. Tools

All take `project` (name under the Root) and `file` (project-relative path).

| Tool | Does |
|---|---|
| `list_projects` | Projects under the Root, with status and word count |
| `list_files` | Manuscript `.md` files in a project, with chapter count and words |
| `list_chapters` | Chapter headings of a file with line ranges and words |
| `read_chapter` | Text of one chapter (optionally with line numbers), plus the notes already on it |
| `get_notes` | Notes filtered by file / chapter / status / reviewer / category |
| `add_comment` | `quote`, `body`, optional `category`, optional `before` / `after` context |
| `add_suggestion` | `quote`, `replacement`, optional `body` (the reason), `category`, context |
| `add_notes` | Batch of the above (max 50 per call) so one pass is a handful of calls |
| `reply_to_note` | Reply in an existing thread (e.g. to answer the author's reply) |
| `withdraw_note` | Delete one of the **AI's own** notes; never anyone else's |

**Anchoring rules** (the part that makes it reliable): the server finds `quote` in the current file text. Not found → error with the closest match. Found more than once and no context → error asking for `before`/`after` and saying how many matches. Found once → `makeAnchor` builds the stored anchor. Quotes longer than ~300 characters are rejected (suggestions should be small and local). Every call returns the created note ids and the resolved line number so the AI can verify.

Also exposed as **MCP prompts** (`developmental_pass`, `line_pass`, `copy_pass`) so clients without skills, including GPT-based ones, get the same instructions.

## 5. Identity and the data model

* The server is started with an `--agent` name; each (agent, pass) gets its own file: `ai-claude-developmental.json`, `ai-gpt-line.json`. Displayed as "Claude · Line edit". Separate files mean no write contention with the owner's `owner.json` and an easy "remove everything from this AI".
* Additive fields on `ReviewItem` (the format stays version 1, old readers ignore them): `category?: string` (e.g. `pacing`, `rhythm`, `spelling`) and `origin?: 'human' | 'ai'`. The UI shows an AI badge and a category chip and can filter by both.
* **Race to fix first:** today the app keeps each reviewer file in memory and rewrites the whole file when the owner accepts/rejects/replies, which would erase notes the AI added meanwhile. Change `saveReview` to **read, `mergeReviewFiles`, then write** (the merge function already exists and is built for this), and have the server do the same.

## 6. The three skills

Each is a `SKILL.md` in `skills/` that tells the model what to read, what to look for, and how to record it.

| Skill | Looks at | Records as | Does not |
|---|---|---|---|
| **developmental-edit** | Structure, pacing, stakes, arcs, character consistency, worldbuilding, whether a scene works | Comments only, anchored on the passage; one summary comment per chapter | Rewrite prose or flag typos |
| **line-edit** | Sentence rhythm, word choice, filter words, repetition, tags, show vs tell | Suggestions with a one-line reason; comments where no rewrite is obvious | Change plot; fix pure spelling |
| **copy-edit** | Spelling, grammar, punctuation, hyphenation, consistency (style sheet), timeline slips, doubled words | Suggestions, small and exact | Change voice or content |

Shared procedure: list files → `list_chapters` → for each chapter `read_chapter` (which includes existing notes; skip anything already raised or resolved) → add notes in batches → finish with a short written summary in chat. Notes are short, tagged with a `category`, and aimed at the author's decision. Quotes are the smallest span that is unambiguous.

You already have personal developmental, line and copy editing skills with fiction-specific criteria (LitRPG, progression fantasy). **Open question:** fold their criteria into these, or keep these generic and let yours run alongside them? My default: copy their checklists into the MDEdit skills so there is one source of truth, and add only the "how to record it" half.

For GPT: the same text as `skills/portable/*.md`, pasted into a Custom GPT / project instructions, or delivered via the MCP prompts above.

## 7. App changes (phase 3)

* Watch `.mdedit/review` (poll every few seconds on mobile where watching is unreliable) and reload; new AI notes appear without a restart.
* Notes panel: AI badge, category chips, filter by reviewer / category / kind. "Accept all line edits from…" with a confirm, since accepting a suggestion edits the chapter.
* Settings → **AI reviewers**: shows the folder the server will use, a copy-paste config snippet for Claude Desktop / Claude Code / other clients, and a list of AI reviewer files with a remove button.

## 8. Safety

* Write surface is one file per agent under `.mdedit/review/`; the manuscript is never modified. Path traversal and symlinks are rejected (same rules as `buildPackage`).
* Manuscript text is untrusted input to the model. The worst a prompt injected into a chapter can do is add junk notes, which the author deletes or removes in bulk. No tool deletes or edits anything but the AI's own notes.
* Limits: note count per call, total notes per file per run, quote and body length.
* HTTP mode (phase 5): binds to 127.0.0.1, requires a bearer token generated in Settings, and nothing is exposed until the user turns it on.

## 9. Phases

0. **Spike (half a day).** Confirm the stdio config works in Claude Desktop and Claude Code, and settle what ChatGPT/GPT clients can reach today. Decide the phase 5 scope on that evidence.
1. **Core.** `src/shared/agent/` with the tools, anchoring rules and merge-on-save; `category`/`origin` fields. Tests on `memoryFs`: unique / ambiguous / missing quotes, batch limits, withdraw only own notes, round trip with `applySuggestion`, concurrent write with the app's save.
2. **stdio MCP.** `mcp/server.ts` on the official TypeScript SDK, built by `scripts/build-electron.mjs`; `MDEdit.exe --mcp`. Integration test with the SDK's in-memory client. Docs with config snippets.
3. **App UI.** Watch and reload, badge, chips, filters, AI reviewers settings page.
4. **Skills.** The three skills, portable versions, MCP prompts; try each on a sample chapter and tune.
5. **Optional: HTTP and REST.** Streamable HTTP transport and `/api/*` routes over the same core, token auth, a how-to for exposing it (tunnel) for ChatGPT and Custom GPTs.
6. **Release.** README "Review with AI" section, CHANGELOG, version bump (0.6.0).

Phases 1–2 alone already deliver the goal on the desktop. Everything after is polish or reach.

## 10. Risks and things to verify

* Whether `.mdedit/review/*.json` is covered by sync rules (`src/shared/sync/rules.ts` only mentions `Shared With Me`); the review-sharing exchange may be the only path. Check before promising "AI notes on your phone".
* A suggestion's `start` offset goes stale as you edit; the anchor's prefix/suffix handles that, but very short quotes in repetitive prose can attach to the wrong occurrence. The ambiguity error and a minimum-context rule mitigate this.
* Large chapters: `read_chapter` returns one chapter by default and a size warning above ~15k words.
* The electron exe running as MCP must not open a window or take the single-instance lock; check `electron/launch.ts` before adding `--mcp`.
* Client support for MCP is moving quickly; keep the tool set small and the schemas plain so they work across clients.
