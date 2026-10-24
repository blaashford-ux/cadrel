# Changelog

### 0.8.5 — 2026-10-24
**Fixed**
- **Settings → Save works the first time you open it.** On a fresh install the Save button stayed greyed out until you changed something, so you had to pick the Root Folder by hand even to keep the default. Save is now available until the first setup is done, and it saves the default Root Folder and creates it.
- **The AI could report "no projects" when its Projects folder was wrong.** The Claude Desktop extension's "Projects folder" is now optional and, when empty, follows the Root Folder set in MDEdit instead of a path frozen when the kit was saved. If the folder it was given has no projects but MDEdit's own Root Folder (or the default) does, the server uses that. When there are still none, `list_projects` names the folders it looked in and what to check. Save the AI Kit again to get the new extension.

### 0.8.4 — 2026-10-23
**New**
- **Unmark Edited to Here** on a chapter's right-click menu unmarks that chapter and every chapter before it in the file, the opposite of **Mark Edited to Here**.
- **AI can mark chapters edited.** The AI tools have a new `set_chapters_edited` that marks or unmarks chapters (by number or heading, or everything up to a chapter), and `list_chapters` now shows which chapters are marked. Marks an AI changes appear in the tree within a few seconds. Save the AI Kit again (Notes → AI…) to get the new tool.

### 0.8.3 — 2026-10-23
**Changed**
- **AI reviewers can leave up to 1000 open notes per project, up from 500, and only open notes count.** Resolved, accepted, rejected and deleted notes no longer use up the allowance, so a long project with several editing passes no longer blocks Claude from adding new notes.

### 0.8.2 — 2026-10-18
**Fixed**
- **Help → MDEdit Help (F1) is back.** 0.8.0 and 0.8.1 were built without the Help window added in 0.7.6, so the Help menu showed only About. They now include everything from 0.7.6 as well. The help guide also describes the new Collaborator links.

### 0.8.1 — 2026-10-18
**New**
- **Collaborators get every file in the project.** A collaborator's copy now holds every Markdown file (notes, outlines, other books), not just the active manuscript, and they can create new files, which reach you on the next sync (and your new files reach them). Reviewers are unchanged: they still see only the active manuscript. The chapter ticks in the Share dialog now limit only the active manuscript for a collaborator; every other file is shared whole. A collaborator no longer needs an active manuscript to be set.
- Only Markdown files travel; images, exports, settings and hidden folders stay where they are, and files arriving from a collaborator's copy are accepted only if they are Markdown outside hidden folders and `Exports/`.

**Notes**
- Deleting or renaming a file is not passed on: the other author's copy brings the file back (a rename leaves the old file behind).
- A collaborator invited with 0.8.0 keeps working on the manuscript only; remove them and send a new link to give them the whole project.

### 0.8.0 — 2026-10-17
**New**
- **Collaboration: editable links.** In the Share dialog each new link is now either a **Reviewer** (comments and suggestions only, as before) or a **Collaborator (can edit)**. A collaborator opens the invitation the same way, but gets a copy of the manuscript they can change: all of it, or only the chapters you ticked. Their edits and yours are merged each time either of you syncs: a chapter only one of you changed is simply taken, edits to different paragraphs of one chapter are combined, chapters one of you adds or deletes carry over, and where you both changed the same lines both versions are kept in the text between `<<<<<<<` and `>>>>>>>` lines, with a notice, so nothing is lost. A collaborator can leave notes too, but can't share the project on or see other people's links. Removing a collaborator first takes their last changes, then closes their copy.
- **Collaborators can use the AI tools too.** The Notes panel's **AI…** button is available on a project you were invited to edit. The MCP server lists such projects as `Shared With Me/<name>` (projects shared for review only are still left out), so the same skills (line, copy and developmental edit) work on the collaborator's own copy.
- **The editing group shares notes.** Everyone invited as a collaborator, and the owner, now see each other's notes, replies and resolutions, including the notes AI reviewers left for each of them, which carry the AI badge as usual. They travel inside each collaborator's comments file, and a collaborator who wasn't given every chapter only receives notes on the chapters they have. People invited only as **reviewers** are unchanged: they see just their own notes, and their notes are never passed to collaborators.
- The Share dialog shows **can edit** beside collaborators, and the invitation message you copy says they're being asked to work on the manuscript.

**Notes**
- Saves reach the other author within seconds; otherwise the exchange runs every minute while the project is open. Changes pass from one collaborator to another through the owner's copy, so the owner's MDEdit needs to be open and online for that.
- The order of chapters is not merged: each author keeps their own.

### 0.7.6 — 2026-10-17
**New**
- **Help window.** **Help → MDEdit Help** (F1) opens a help guide in its own window, so you can keep it beside the editor. It covers every feature in short topics with examples, links between related topics, a contents list, search, and back/forward navigation.

### 0.7.5 — 2026-10-16
**New**
- **Share only some chapters.** The Share dialog now has a scrolling list of the manuscript's chapters with a tick box for each (**All** / **None** above it). A reviewer's link gives them only the ticked chapters: they get their own copy of the manuscript containing just those chapters, which stays up to date as you edit, and their notes come back as usual. Your ticks are remembered for that manuscript, so sending several links doesn't mean re-ticking the same boxes; a chapter added later starts unticked. Ticking every chapter shares the whole manuscript, as before. Removing a reviewer also closes their copy.
- **Mark Edited to Here** on a chapter's right-click menu marks that chapter and every chapter before it in the file as edited (marks already set stay).

### 0.7.4 — 2026-10-14
**New**
- **Import Word documents.** Right-click a folder → **Import Word Document…**, or use the **Import** button at the top of the file tree (next to **File** and **Folder**). Pick one or more `.docx` files and each becomes a Markdown file of the same name in that folder (a taken name becomes `Name (2).md`). Headings (including Title) become `#` headings; bold, italic and strikethrough, links, bullet and numbered lists, block quotes and tables are kept. Windows app only.

### 0.7.3
**Fixed**
- **Notes keep their place when you edit the text they're on.** Deleting some of a highlighted passage no longer removes the note and its highlight; they stay on what's left. If all of the text is deleted, the note is marked Resolved ("text deleted") and stays at that spot.
- **Accepting a suggestion that is in another chapter** now opens that chapter and applies it, instead of saying the text has changed.
- **"Mark Edited?" is asked when you leave any chapter in the Editing stage**, not only ones you changed and saved. Reading a chapter through and moving on now offers it too (not for chapters already marked, and not again after "Not Yet" until you save it).
- **The phone's Sharing page showed "Nothing shared yet"** for projects shared from the PC. The phone looked for the shared-reviews folder in Drive by a test that real Drive doesn't satisfy, so it never found the PC's list of shares (and could have made a second folder).

### 0.7.2 — 2026-10-13
**Fixed**
- **Reviewers now see only the active manuscript.** A shared project used to give reviewers every Markdown file in it (other books, notes, drafts). The package is now the project's active manuscript and nothing else; a project with a single prose file needs no choice, otherwise Share asks you to set the Active Manuscript first (right-click the file). Changing the active manuscript later takes the old file off reviewers' copies the next time they sync, and the Share dialog says which file they see.
- **The phone and the PC now show the same shares.** What an owner has shared was remembered per device, so the phone's Sharing page was empty and it never collected reviewers' notes. The owner's shares are now merged through a small file in the Drive reviews folder: the phone lists the PC's reviewers (and the other way round), invites made on either appear on both, and a reviewer removed on one stays removed on the other. The phone also collects notes from the reviewers' files directly.
- **Notes that arrive with a sync appear straight away.** After a Drive sync brought in new review notes the Notes panel kept showing the old list until you reopened the project.

### 0.7.1 — 2026-10-12
**New**
- **Text alignment.** Align any part of your text left, centre, right or justified, and see it as you write and in the exported EPUB, print PDF and Word file. In the file it is a fenced block (`::: center` … `:::`, also `left`, `right`, `justify`) that can hold paragraphs, headings, quotes and lists. In the editor, four buttons set it for the selected paragraphs (on the phone they are in the bar above the keyboard), the same button again removes it, and Ctrl+Shift+L / E / R / J do the same from the keyboard. Details in [docs/alignment.md](docs/alignment.md).
- **Body text alignment** is now an export setting for each output (EPUB, print PDF, Word): *Justified* (as before, still the default) or *Left (ragged right)*. It layers like the other settings (app → project → book).
- Word counts, progress and text analysis ignore the fence lines, and the AI review tools see the same text the editor shows.

### 0.7.0 — 2026-10-11
**New**
- **Analyze Text** on a file's right-click menu. It reads the manuscript (including unsaved edits to the open chapter) in the background, then adds `<name> - Analysis.md` next to it and opens it in a new tab without switching to it. Running it again makes `… Analysis 2.md`, so earlier reports are kept for comparison.
- The report opens as a **formatted page**: stat tiles, bar and column charts, per-chapter sparklines, a reading-level gauge, heat maps, tables and highlighted examples, following the light or dark theme. **Save as HTML** writes one self-contained page; **Save as PDF** writes a PDF (desktop). **Edit as Markdown** shows the file's text, which is complete on its own (tables and block-character charts). The page is drawn from results stored in a one-line comment at the end of the file.
- It covers: dialogue share and tags; sentence length, rhythm and openers; reading level (Flesch, Flesch–Kincaid, Gunning Fog, Coleman–Liau, ARI, SMOG); repeated words, close echoes and repeated two- and three-word phrases; adverbs; passive voice with examples; filler, filter and crutch words ("just", "really", "that", "seemed", "felt", stock gestures); point of view, tense and possible head-hopping; characters (mentions, where they appear, tagged lines); punctuation habits.

**Notes**
- **People can use topics too.** The note form has an optional **Topic** (free text, with suggestions: the topics already in the project plus a standard set), and each note's topic chip is a button to change or clear it (**+ topic** when it has none). The author can retag any note, including AI notes that came without one; a reviewer can retag their own. Topics are stored the same way the AI tools store them, so the **All topics** filter covers both.

**Fixed (phone)**
- **Selecting text works the way the system does it.** Press and hold no longer opens an app menu over the text (it covered the selection handles, and "Select all" sat under the finger). Selection is Android's own: its handles and menu. The formatted editor's floating toolbar, hover handles and virtual caret are off on the phone too. Instead a bar docked above the keyboard appears while you type: with text selected it offers Cut, Copy, Paste, Comment, Suggest, Bold, Italic and Find; with nothing selected, formatting (bold, italic, headings, quote, lists, scene break, undo/redo), Paste and Find.

### 0.6.8 — 2026-10-12
**Fixed**
- **Sharing: a reviewer could pick both files and still fail with "Drive 403: This file cannot be downloaded by the user."** The shared copy of the manuscript was marked "copying requires writer permission", which also stops people who only have the link from downloading it. Read-only links are now left downloadable, and the shared copy of a project that was shared before (including ones shared with 0.6.7) is corrected the next time MDEdit exchanges notes for it.

### 0.6.7 — 2026-10-11
**Fixed**
- **Sharing: a reviewer invited after you removed the previous reviewer could not open the project.** Removing a project's last reviewer closes the shared copy of the manuscript, and the next invitation re-used that copy without opening it again, so the reviewer's file picker offered only their comments file. Inviting now opens the shared copy again, and MDEdit repairs invitations already sent that way (when it next exchanges notes for that project).
- **Editing stage: "Mark Edited?" is now asked when you press Next chapter on the last chapter.** There the button adds a new chapter and opens the New chapter dialog, so a saved chapter was only offered afterwards, and not at all if you cancelled the dialog. It now asks first, once (not again until you save again), then opens the dialog.
- **Opening an invitation: picking only one of the two files no longer sends you back to the start.** Google's picker lets you tick one or both files; if only one came back, MDEdit now opens the picker again for just the other file (each pick is remembered), and the picker's title says how to pick two (Ctrl or Shift + click). If Google returns something unexpected, the message now says what it returned, so it can be diagnosed.

### 0.6.6 — 2026-10-10
**New**
- **Notes: "This chapter only" switch.** A toggle at the top of the Notes panel limits the list to the notes in the chapter you are reading. It combines with the "from" and "about" filters, "Apply all" only touches the notes shown, and MDEdit remembers the switch. It only appears for files with more than one chapter.
**Fixed**
- **Windows: Google's file picker (opening an invitation) now opens in your browser instead of inside the app.** Embedded two frames deep inside the app the picker showed up blank. MDEdit now opens the invitation page in your default browser and waits for the answer on a local address (127.0.0.1, like Google sign-in does); after picking the two files the browser tells MDEdit and the app carries on. The phone already worked this way since 0.6.5.

### 0.6.5 — 2026-10-09
**New**
- **Zone Mode (Windows).** The Zone button at the right end of the chapter bar (or F8, or View → Zone Mode) takes the app full screen and shows only the file you're working on, with its chapter bar: previous/next chapter, scene breaks, Notes, Save. No sidebar, tabs, title bar or status bar. The Zone button stays in the same place in both modes; press it again, F8 or F11 to leave.
- **Next chapter on the last chapter adds a new one.** The button turns into a "+" on the last chapter, and clicking it (or Ctrl+PgDn) opens the usual New chapter dialog to add one after it. Works on the phone too; read-only shared projects can't add chapters.
- **Theme customiser.** File → Settings → Appearance lets you change the colours of the light and dark themes separately: window, page, text, accent and highlight, each with a colour picker or a hex code, plus a few ready-made starting points (Paper, Mist, Sage for light; Midnight, Ember, Forest, Black for dark). Panels, buttons and softer text are worked out from your five colours. Changes show immediately; Save keeps them, Cancel puts the old ones back. Each theme has its own reset. Works on Windows and Android.
**Fixed**
- **Review notes now sync between your devices.** Comments and suggestions (yours and any AI reviewer's) were only kept on the device they were made on; they now travel through Google Drive with the project, and if both devices added notes, both sets are kept. Needs the update on every device.
- **Windows: another try at "Installer integrity check has failed" when updating from the app.** The installer is now read back once more right before it is run (and refused if it changed), and it is started the way a double-click starts it instead of directly. Each step is also written to `%APPDATA%\MDEdit\update.log`; if it happens again, that file shows whether the installer was intact when MDEdit started it. This is a guess at the cause, not a confirmed fix.
- **Phone: opening a review invitation now runs Google's file picker in your browser.** Inside the app the picker stayed blank, so the app hands over to the browser; after you pick the two files, tap "Return to MDEdit" and the app carries on. (Needs the new phone app. The Windows app is unchanged.)

### 0.6.4 — 2026-10-08
**Fixed**
- **Phone: Google's file picker no longer shows up blank inside the invitation dialog.** The phone app now lets the picker use Google's cookies (Android blocks them for embedded pages by default). Not yet confirmed on a phone. (Needs the new phone app.)

### 0.6.3 — 2026-10-08
**Fixed**
- **Phone: opening a review invitation no longer fails with "The API developer key is invalid".** The phone app handed Google's file picker to the phone's browser, where Google rejects it. The picker, and the invitation page that runs it, now stay inside the app. (Needs the new phone app on the person opening the invitation.)

### 0.6.2 — 2026-10-08
**Changed**
- **The project switcher lists your most recently opened projects first.** The "Switch to" list (and the Ctrl+K quick switcher) used to be ordered by project status; now the project you opened most recently comes first, then the one before it, and so on. Projects you haven't opened on this device yet follow, newest edit first. In the Ctrl+K list the project that's open goes last, so Ctrl+K then Enter returns to the one you were in before. The order is remembered on each device and is not synced.
**New**
- **Click highlighted text to find its note.** Clicking text that has a comment or suggestion opens the Notes panel if it is closed, marks that note, and scrolls it to the top of the list, even if a filter or "finished" would have hidden it. The text stays where it is.

**Fixed**
- **Updating MDEdit from About on Windows is safer.** The installer is now saved under a temporary name and only given its real name once it is complete and checked, so a half-written or damaged file can never be started. The check reads the saved file back from disk (not just the data as it arrived), confirms every byte arrived, and compares it with the release's checksums; a mismatch says what went wrong. Asking twice no longer downloads the same file twice, and old installers are cleared out of the temporary folder. This targets the Windows "Installer integrity check has failed" message some people got when updating from the app although the same installer downloaded from the release page worked.

### 0.6.1 — 2026-10-08
**New**
- **Click a note to go to it.** In the Notes panel, clicking a note now scrolls to its text and highlights it, opening the chapter it is in if that is a different one. If the chapter you are leaving has unsaved changes you get the usual Save / Don't Save / Cancel question first (Cancel keeps you where you are). A note whose text has been deleted from the file says so instead of doing nothing.

### 0.6.0 — 2026-10-08
**New**
- **Review with AI.** Claude, GPT and other AI apps can read your chapters and leave comments and suggestions in the Notes panel, signed with the AI's name. They can't change your text. Notes carry an **AI** badge and a topic label; when more than one person or AI has written notes you can filter by who and by topic, and with one reviewer chosen **Accept all N suggestions** applies theirs after a confirmation. Notes written outside the app appear within a few seconds, with no restart.
- **Notes → AI…** connects an AI app. **Save files to Downloads** writes a **MDEdit AI Kit** folder: a Claude Desktop extension (`mdedit.mcpb`), the editing skills as upload-ready zips and folders, the server with ready-made settings for Claude Code and Codex, instructions to paste into GPT apps, and a README. The dialog also lists each AI reviewer's notes, with **Delete all…** for one reviewer. In the installed app the connection runs on MDEdit itself, so Node.js isn't needed.
- **Three editing skills,** not tied to a genre: **Developmental edit** (comments on structure, pacing, stakes, continuity), **Line edit** (suggestions for sentences, comments on patterns and strengths) and **Copy edit** (exact corrections, grouped by pattern, with a running style sheet). They follow the author's style sheet and notes. Notes are signed "Claude · Line edit", or just "Claude" with no skill. The same instructions are offered as MCP prompts for clients without skills.
- **The connection** (an MCP server) can read chapters one at a time as plain text, search the whole book for a name or term, and add, reply to, and withdraw its own notes. A note whose quote can't be found, or matches several places, is rejected with the reason so the AI can correct it.
- **Online apps (advanced, off by default).** For apps that can't run a program on your PC (the ChatGPT app, Custom GPTs): **Notes → AI… → Online apps** listens on this PC only and answers only requests carrying a long random token, as MCP over HTTP and as a REST API with an OpenAPI description for a Custom GPT's Actions. Making it reachable from the internet is up to you (for example a tunnel); the dialog explains the risk. The token can be replaced at any time.

**Changed**
- Saving a reviewer's notes now merges with what is already on disk, so accepting or rejecting a note can no longer erase notes added in the meantime by an AI or the other side of a share.

**Fixed**
- Note cards in the Notes panel could be laid out sideways, because the export-settings list used the same style name.

### 0.5.0 — 2026-10-07
**New**
- **Comments and suggestions.** Select text, or right-click it (press and hold on the phone), and choose **Add comment…** or **Suggest a change…**; with nothing selected the note attaches to the paragraph. The **Notes** button on each chapter opens a panel to reply, resolve, reject, accept (a suggestion edits the chapter) and delete. Notes are highlighted in the text and follow it as you edit; a note whose text was deleted stays in the list, marked *not in this chapter*. They are stored one file per reviewer under `.mdedit/review`.
- **Share a project for review.** Notes → **Share…** makes one link per reviewer. Reviewers open it under **Projects → Shared with me → Open invitation…**, Google's file picker gives MDEdit access to just two files, and the project opens read-only. They can read and leave notes; they can't change your text or see each other's notes. You see everyone's notes together, each labelled with who wrote it. Your text is re-uploaded automatically after you save, so reviewers always see your latest version; their notes reach you within about a minute. Removing a reviewer closes their file and keeps their notes. Needs Google Drive sync on both sides. Projects shared with you never sync into your own Drive.
- **Sharing page.** **Projects → Sharing** lists every project you've shared, with its reviewers and open notes; **Manage links…** opens that project's links (copy, remove, or **Stop sharing…**), and projects not shared yet have a **Share…** button. Each link can be copied two ways: **Copy link** for the link alone, or **Copy invitation**, a short note with a link to download the latest MDEdit and what to do with the invitation. Pasting a whole invitation message into **Open invitation…** works too.
- **Phone: the find bar fits the screen.** Its options wrap onto lines instead of running off the right edge, so the Close button is always reachable; the magnifier in the top bar opens and closes it.
- **Invitation page.** A small web page (published with GitHub Pages) explains an invitation link and hosts Google's file picker inside the app.
- **Update from About.** Help → About MDEdit (the ⓘ button on the phone) has a **Check for updates** button. If the latest GitHub release is newer, **Update** downloads the file for your device (the Windows installer, or the Android app), checks it against the release's checksums, then closes MDEdit and runs the installer (Windows) or opens Android's installer. The first time on Android you are sent to allow MDEdit to install apps. Android only accepts the update if the release was signed with the same key as the installed app.

### 0.4.3 — 2026-10-07
**New**
- **Phone: Find and Replace.** A magnifier button in the top bar opens the find bar (next / previous, match case, whole word, regular expressions, replace) for the open file.
- **Phone: press-and-hold menus.** Holding a file, folder or project opens MDEdit's own menu without the phone's system menu covering it. Holding on text in the editor opens Cut, Copy, Paste, Select all and Find.
- **Also by the author: a blurb for each book**, printed under its title and link in the EPUB, print PDF and DOCX.
- **Projects home: filter by status** (Planning, Drafting, Revising, Editing, Published, On hold), alongside search, sort and Archived.

**Changed**
- **Project switcher order:** projects you are editing come first, then Planning, Drafting and Revising, with Published and On hold last.
- **Back matter is easier to read in the print PDF and DOCX:** a blank line between paragraphs, lines and links, and the line breaks you type in the back-matter fields are kept (a blank line starts a new paragraph).

### 0.4.2 — 2026-10-07
**New**
- **Export settings follow app → project → book, field by field.** Each level stores only the fields you change; every other field follows the level above, so editing a project's (or the app's) back matter, author, fonts or layout now reaches every book that hasn't set that field itself. Previously each book kept a full copy made when it was first set up, so later changes never reached it.
- Every field in **Project Settings → Export defaults**, **Book Details** and **Export** is tagged *From app settings*, *From project settings* or *Set for this book*, with a **Reset** that hands it back. The Export dialog ends with a list of every setting that doesn't simply follow the app, with where it is set.
- **Chapter drop** (Export → Print PDF): the space above each chapter heading, from 0 (flush with the top margin) to 3 in; the default stays 1.25 in.

**Changed**
- **Project settings** replace 0.4.1's single **Override** switch with per-field overrides (templates keep the switch). A project starts from what its template changes relative to the app.
- Existing files are converted the first time they are opened: a project's saved book becomes the fields it changes, and a book's `.export.json` keeps only the fields that differ from what it would inherit (the rest now follow the project and app). The previous book file is kept beside it as `<name>.export.v1.bak` (never synced). The copyright year is fixed when a book is first set up, so it doesn't change with the calendar. Excluded chapters and the cover image stay with each book.
- A book whose settings differed from its project (for example a back matter page typed into the book earlier) keeps those as its own and shows *Set for this book*; **Reset** it to follow the project.

### 0.4.1 — 2026-10-07
**New**
- **Line numbers** in the right margin, outside the text: every row you see is numbered, wrapped rows and blank lines included, and every tenth is always visible in a faint colour. The rest appear while the pointer is over the editor, with the line under the pointer picked out. Numbers run through the whole file; the open chapter is measured exactly and the others are estimated, so numbers in other chapters can be a little off and change if you resize the window.
- **Go to Line** (Ctrl+G, Edit → Go to Line…, and a **Line…** button on the phone): jumps to a numbered row anywhere in the file, opening another chapter if needed and asking about unsaved changes first.
- **Editing stage**: while a project's status is *Editing*, every chapter in the file list has a red empty circle. Leaving a chapter you saved asks whether to mark it edited, which turns the dot into a filled green one; *Mark Edited* / *Unmark Edited* are also on the chapter's right-click menu. Marks stay with a chapter when it is moved, retitled or its file is renamed, and stay when the status changes.
- Edited marks are kept in their own file (`.mdedit/edited.json`) and **merge between devices** when syncing, chapter by chapter, so marks made on your phone and your PC both survive.
- **Project settings show every setting**: chapter-heading level and the title, front/back matter and export defaults are always visible, read-only with the app's values until you tick **Override**, which makes them editable.

**Changed**
- **Word counts and goals follow the active manuscript only.** The Projects cards, Quick Switcher, status-bar total and Progress window show “-” when no manuscript is active. Each manuscript keeps its own goal and writing history, so choosing it again brings them back. Project Settings → Goal now asks you to pick an active manuscript first, and the old “What counts” folder list is gone.
- **Ctrl+G is now Go to Line.** Find Next and Previous stay on F3 and Shift+F3 (Ctrl+G and Ctrl+Shift+G no longer do that).
- A sync, or Refresh, now also reloads the open project's edited marks, status, active manuscript and goals, so changes from another device appear without reopening the project.

**Fixed**
- **A chapter always opens at the top**, instead of keeping the scroll position of the one before it.
- **Phone: the chapter header no longer paints over the file drawer** when it is open, and the backdrop now dims it too.

### 0.4.0 — 2026-10-06
**New**
- **Android app** (an APK on each release): the editor, Projects home, goals and progress on your phone, with files stored on the phone. It has no KDP export, fonts or Explorer actions, and its Root Folder is fixed.
- **Google Drive sync** on Windows (File → Google Drive Sync…, plus a status-bar chip) and Android (cloud button): sign in once per device; MDEdit keeps your projects in an `MDEdit` folder in your Drive and can only see files it created there. Passes run a few seconds after you save, when you return to the app, and every minute or two; a status screen shows progress, the last pass and any problems.
- **Keep both versions on conflict**: a chapter changed on two devices keeps Drive's version under its name and your other version beside it as `Name (conflict - Device - date).md`. Writing history is merged day by day; project settings use the last writer. A delete beats nothing that was edited elsewhere, and a sync that would delete most of your files stops and asks first.
- **Windows-compliant names everywhere**: new and renamed files and folders follow Windows' rules on every device (no `< > : " / \ | ? *`, reserved names, trailing dots or spaces; at most 120 characters). Names that arrive from Drive in another form are renamed to match, in Drive too.
- Files deleted by another device go to the **Recycle Bin** on Windows and to the app's trash on Android.

**Notes**
- Only text files sync for now (`.md`, `.txt`, `.json`, `.csv`, `.html`, `.css`, `.xml`, `.yml`); images and other binaries, and each project's `Exports` folder, are left alone.
- Sync covers the Root Folder. Don't put it inside OneDrive, Dropbox or Google Drive for Desktop, or two syncs will fight over it.
- Sync is much faster than the first builds: transfers run in parallel, scans use the file listing instead of a lookup per file, and the Projects screen caches word counts.

**Changed**
- The Windows installer is built with the Google sign-in configured. The Android app is signed with your own key.

### 0.3.0 — 2026-10-05
**New**
- **Projects**: a project is a folder (with subfolders) marked by a small hidden `.mdedit` folder. MDEdit works out of a **Root Folder** (default `%USERPROFILE%\MDEdit`; chosen on first run, changeable in Settings, with an offer to move your projects). A welcome screen sets this up the first time, and offers the folder you last used as a project.
- **Projects home** with a card per project (status, word count, goal progress, last edited), search, sort, archive, and a context menu to open, rename, duplicate, change status or delete (to the Recycle Bin, after typing the name).
- **New Project** dialog (Ctrl+Alt+N): name + template with a live preview of the folders it will create. Built-in templates: Novel, Series, Short story, Blank.
- **Project templates** (Settings → Projects): edit the folder tree, which folders count toward word goals, starter files and the export defaults each template carries.
- **Project switcher** in the sidebar and **Ctrl+K quick switcher**; File → Open Folder still opens any folder, and other folders in the Root can be converted to projects.
- **Per-project overrides**: chapter-heading level and export defaults can be set per project; the template's values are copied in when the project is made.
- **Project status** (Planning, Drafting, Revising, Editing, Published, On hold) and notes.
- **Word-count goals and progress**: target and optional deadline; Progress window with a day-by-day bar chart, burn-down against a steady-pace line, words per day needed, and estimated completion at the 3-day and 5-day averages; running total in the status bar.
- **Series template**: a Manuscripts folder for several books (no book files created) plus a series bible.
- **Editing stage**: while a project's status is *Editing*, every chapter in the file list has a red empty circle; leaving a chapter you saved asks whether to mark it edited (filled green). *Mark Edited* / *Unmark Edited* are on the chapter's right-click menu. The marks live in their own `.mdedit/edited.json` (by file and chapter title, so they follow moved, retitled and renamed chapters), stay when the status changes, and merge between devices when syncing.
- **Active Manuscript**: right-click a file → *Active Manuscript* to make word-count goals and progress follow that single file (one at a time; choosing another swaps without asking). Project word counts and goals exist only for the active manuscript: with none chosen the cards, status bar and Progress window show “-”, and a manuscript's stats are kept and come back when it is chosen again. A target marker shows on the file in the browser, the Progress chart and tiles are labelled with its filename, and each manuscript keeps its own goal and writing history.

**Changed**
- The sidebar's folder button became the project switcher; File → Change Folder is now **Open Folder**.


### 0.2.0 — 2026-10-05
**New**
- **Find & Replace** (Ctrl+F / Ctrl+H, F3 / Shift+F3, Edit menu): highlights in the formatted editor, works in Source mode, match case / whole word / regular expressions (`$1`, `$&` in replacements); search this chapter or the whole file (Replace All in the file asks first).
- **Undo Last Action** (Ctrl+Alt+Z, redo Ctrl+Alt+Y, Edit menu, status-bar button): reverses the last 5 delete / move / add-chapter actions and whole-file Replace All.
- **Settings** (File → Settings, Ctrl+,): choose which heading level starts a chapter (H1–H6), set the template new books start from (author, copyright page, dedication, epigraph, back matter) and the default export choices.
- **Fonts for export**: EB Garamond, Crimson Pro and Libre Baskerville (all open-licence) ship with the app and are embedded in EPUB and PDF; any font installed on your computer can be used for the print PDF.
- **Scene-break navigation**: Ctrl+↑ / Ctrl+↓ or the ↑ Scene / ↓ Scene buttons jump between scene breaks, in Visual and Source mode.
- **New look**: borderless, tonal, rounded design with a palette drawn from the app icon, in light and dark, with line icons.
- **Custom title bar**: frameless window with in-window File / Edit / Go / View / Help menus (mouse, arrows, Alt+letter), the open chapter and file, and window buttons (drawn by the OS on Windows).
- The chapter heading and toolbar stay pinned while you scroll.
- The copyright page has an optional **Content Warning** notice (default text “Add Content Warnings here”).

**Changed**
- Export files (`<name>.export.json`) use the field names `contentWarning` / `contentWarningText`; older files are tidied automatically the first time they are read.
- Exports record the chosen fonts; a missing font falls back to EB Garamond with a warning.
- Clicking Undo / Cut / Copy / Paste in the menu now acts on the editor (the menu no longer takes focus).

**Release pipeline**
- Pushing a version tag, or running the *release* workflow from the Actions tab, builds, tests and publishes the Windows installer with checksums (see `docs/RELEASING.md`).

### 0.1.0 — 2026-10-05
- First release: folder browser with expandable folders and empty folders, chapter-at-a-time WYSIWYG editing (Milkdown), Save / Don't Save / Cancel prompts, external-change detection, tabs, session restore, crash-recovery drafts, dark mode, Source mode, file and chapter management.
- **Export for KDP**: mark a file for export, fill in Book Details (title page, copyright page, dedication, epigraph, back matter), export to EPUB 3, KDP print-interior PDF (trim sizes from 5 × 8, automatic gutter) and DOCX.
- Windows installer with app icon, single instance and `.md` file association.
