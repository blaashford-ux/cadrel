# AI reviewers (MCP)

MDEdit ships an MCP server so Claude, GPT and any other MCP client can read your chapters and leave **comments and suggestions** in the Notes panel, like a human reviewer. It cannot change your manuscript: you accept or reject each note in MDEdit. Design and plan: [milestone-9-ai-review-plan.md](milestone-9-ai-review-plan.md).

## The AI Kit (easiest)
In MDEdit open a project and choose **Notes → AI… → Save files to Downloads**. It writes a **MDEdit AI Kit** folder to your Downloads and shows it. Open `README.txt` there for the steps. It holds:

| File | For |
|---|---|
| `mdedit.mcpb` | Claude Desktop: double-click, or drag into Settings → Extensions. Claude Desktop runs it with its own Node, so nothing else is installed. Its "Projects folder" setting can stay empty: it then follows the Root Folder set in MDEdit. |
| `skills/*.zip` | Claude Desktop and claude.ai: upload each under Settings → Capabilities → Skills. |
| `skills/folders/` | Claude Code: copy into `~/.claude/skills`. |
| `mdedit-mcp.js`, `connect-settings.txt` | Claude Code, Codex (GPT) and other MCP apps: ready-made settings pointing at the saved server (needs Node.js 20+). |
| `for-gpt/*.md` | GPT apps without skills or prompts: paste into custom instructions. |

Nothing extra is installed or kept up to date by MDEdit: the kit is a copy. Save it again after updating MDEdit. The server and skills ship inside the app (the server is unpacked beside `app.asar`, the skills are compiled into the app), so no files are added to the install folder.

## Connect
In MDEdit, open a project, choose **Notes → AI…**. It shows settings ready to copy for Claude Code, Claude Desktop and Codex (GPT), and lists the notes each AI has left, with a button to delete all of one reviewer's notes. In the installed app the server runs on MDEdit itself, so Node.js isn't needed. New notes appear in the Notes panel within a few seconds.

Running from source instead:
```
npm ci
npm run build:electron      # writes dist-electron/mcp/mdedit-mcp.js (one self-contained file; needs Node 20+ to run)
```

It finds your projects by itself: `--root <folder>`, then the `MDEDIT_ROOT` variable, then the Root Folder set in MDEdit, then `~/MDEdit`. `--agent <name>` overrides how the AI is named in the Notes panel (normally taken from the client: "Claude", "GPT").

## Connect a client by hand
Use the full path to `mdedit-mcp.js` below.

| Client | How |
|---|---|
| Claude Code | `claude mcp add mdedit -- node /path/to/mdedit-mcp.js` |
| Claude Desktop | In `claude_desktop_config.json`: `{ "mcpServers": { "mdedit": { "command": "node", "args": ["C:\\path\\to\\mdedit-mcp.js"] } } }` |
| Codex CLI | In `~/.codex/config.toml`: `[mcp_servers.mdedit]`, `command = "node"`, `args = ["/path/to/mdedit-mcp.js"]` |
| OpenAI Agents SDK | `MCPServerStdio(params={"command": "node", "args": ["/path/to/mdedit-mcp.js"]})` |

The ChatGPT app and claude.ai on the web can only reach servers on the internet, not a program on your PC; for those see **Online apps** below.

## Tools
`list_projects`, `list_files`, `list_chapters`, `read_chapter`, `search_text` (find a name, term or spelling across the book), `get_notes`, `add_notes` (up to 50 at a time, and up to 1000 open notes per reviewer; resolved, accepted, rejected and deleted notes don't count), `reply_to_note`, `withdraw_note`, `set_chapters_edited` (marks or unmarks chapters as edited, the same marks as the chapter menu; name chapters or use `through` for everything up to and including one). `list_chapters` shows which chapters are marked.

Quotes in `add_notes` are matched against the plain text `read_chapter` returns (Markdown marks removed, one paragraph per line), which is the same text MDEdit anchors notes to. A quote that is missing, or that matches more than one place, is rejected with the reason so the model can fix it. Suggestions must stay inside one paragraph.

## Online apps (ChatGPT, Custom GPTs): advanced, optional
Off by default. In **Notes → AI… → Online apps** choose **Turn on**. MDEdit then listens on `127.0.0.1` (this PC only) and every request needs the access token shown there (also `Make a new token` to lock out the old one). From the command line: `node mdedit-mcp.js --http [--port 47831] [--token …]`.

| Address | What |
|---|---|
| `/mcp` | MCP over HTTP, for apps that take an MCP server URL |
| `/api/...` | The same tools as REST |
| `/openapi.json` | Description of the REST API for a Custom GPT's Actions (open, so it can be imported; it holds no data) |
| `/health` | `{"ok":true}` |

REST: `GET /api/projects`, `/api/projects/{project}/files`, `/chapters?file=`, `/chapter?file=&chapter=`, `/search?query=`, `/notes`; `POST /api/projects/{project}/notes` with `{ "skill": "Line edit", "notes": [...] }`; `POST .../notes/{id}/replies`; `DELETE .../notes/{id}`. REST callers are named **GPT** unless the `x-mdedit-agent` header (or `--agent`) says otherwise.

**To use it from an online app you must make it reachable from the internet yourself.** For example, run `cloudflared tunnel --url http://127.0.0.1:47831` and use the address it prints. Then:
- **Custom GPT:** Actions → import from URL `https://<address>/openapi.json` → Authentication: API Key, Bearer, paste the token. Paste the text of a `for-gpt/*.md` file into the GPT's instructions.
- **ChatGPT connector or other MCP apps:** use `https://<address>/mcp`. The app must be able to send a bearer token; if it offers only "no authentication" or sign-in, don't expose this to it.

**Think before turning it on.** Anyone who has both the public address and the token can read your chapters and add notes (never edit text). The token is long and random and requests without it get 401, but turn it off when you aren't using it, don't share the token, and replace it if it leaks. Only the file `ai-remote.json` in the app's data folder holds it. It goes through a public tunnel, so your chapters pass through whatever service you pick. These steps and the menus of those apps are from memory and I haven't tried them against the live services.

## The editing skills
Three skills in `skills/` run a full pass and leave the results as notes. They are not tied to a genre: the author's style sheet and notes in the project set the standard, and they look for those first.

| Skill | Leaves | Signed as |
|---|---|---|
| `mdedit-developmental-edit` | Comments on structure, pacing, stakes, continuity, character and the book's own rules; one summary comment per chapter | Claude · Developmental edit |
| `mdedit-line-edit` | One-click suggestions for sentence-level fixes, comments for patterns, a few comments on what works | Claude · Line edit |
| `mdedit-copy-edit` | Exact suggestions for spelling, grammar, punctuation and consistency; one comment per repeated pattern with the count | Claude · Copy edit |

**Install.** Claude Code: copy the three folders into `~/.claude/skills/`. Claude Desktop and claude.ai: zip each folder and upload it under Settings → Capabilities → Skills. They only apply when the MDEdit tools are connected, and they work alongside any other editing skills you have. **GPT and other clients** without skills: the same instructions are offered as MCP prompts named `developmental_edit`, `line_edit` and `copy_edit` (pick one, give it a project and optionally a file), or paste a `SKILL.md` into custom instructions.

The `SKILL.md` files are the source of truth. After editing one, run `npm run build:skills` to refresh `mcp/skills.generated.ts` (the build does it too); a test fails if they drift apart.

## Who a note is signed as
The AI is named from the client ("Claude", "GPT"). `add_notes` and `reply_to_note` take an optional **`skill`**: a skill that passes `"Line edit"` signs its notes **Claude · Line edit**; with no skill the notes are signed just **Claude**. Any label works (`"Dialogue Voice"` gives **Claude · Dialogue Voice**), and `line`, `line-editing` and `Line edit` all mean the same skill. Each signature is its own file, so filtering and deleting work per skill.

## In the Notes panel
Notes from an AI carry an **AI** badge and a topic chip (the `category`). People use topics too: the note form has a **Topic** box (free text; it suggests the topics already in the project plus pacing, continuity, dialogue, character, plot, style, rhythm, clarity, spelling, grammar, punctuation and research, and remembers your last one), and the topic chip on any note is a button that changes it (**+ topic** on a note without one). The author can retag any note, including an AI's or a reviewer's; a reviewer can retag their own. Topics are lower-cased, one line, up to 40 characters, the same as the AI tools store. When there is more than one reviewer or topic, two filters appear. With one reviewer selected, **Accept all N suggestions** applies that reviewer's open suggestions to the chapter after a confirmation.

## Where notes go
Each AI and skill gets its own file, `<project>/.mdedit/review/ai-<ai>[-<skill>].json` (`ai-claude.json`, `ai-claude-line.json`). Deleting that file removes everything that reviewer wrote. Like any other notes they sync between your own devices with the project (merged note by note).
