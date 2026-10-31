# How Cadrel presents work: scope

**Status: design (Phase 0).** Nothing here is built. It changes how the UI thinks, not how data is stored. A clickable mock is in [mocks/ui-model.html](mocks/ui-model.html). Read with [ARCHITECTURE.md](ARCHITECTURE.md), [FILES.md](FILES.md) and [STUDIOS.md](STUDIOS.md).

## 1. The idea

A person is in a **Studio**, and is working in a **Project**. The app shows what belongs to that project and little else. Only where it makes sense does a page step outside a project: Home, the project list, studio totals, administration, and research before anything is assigned.

```
Studio
 └─ Project        a Series by default
     └─ Book       has its own stage; a Book can be closed and a new one opened
```

- A **standalone novel** is a Project that holds one Book, so everyone has the same two levels (decision 1).
- "Project" and "Book" are the two levels the UI knows. The tree underneath can still go deeper (the kernel allows it), but the UI's scope has two: the Project, and optionally one Book in it.

## 2. What lives where

| Level | Holds | Does not hold |
|---|---|---|
| **Project** (series) | series bible, characters, settings and world, style sheet, series premise or arc; associations (Market categories, people, comps); series-wide notes; a series-level tracker ledger | a stage, a manuscript, an outline |
| **Book** | manuscript(s), outline, book premise, blurb and keywords, cover brief, exports, tasks and sign-offs, the **stage**, editions and sales | series canon (it reads the series level instead) |

- A Book **reads** the series level for context and may add its own characters and settings (decision 3). Series files apply to every Book without being copied.
- Folder layout is the one already in FILES.md: `Series Bible\`, `Characters\`, `Worldbuilding\` at the project, `Manuscript\`, `Outline.md`, `Premise.md` in each Book folder.
- The kinds registry gains a **level** (`series`, `book`, or `either`). `character`, `world`, `style` are `either` (series by default); `manuscript`, `outline`, `matter`, `export` are `book`; `premise` is `either` (a series premise and a book premise).

## 3. Stage belongs to Books only

- A Project has **no stage**, only active or archived (decision 2). Today every project and subproject gets a workflow when it is made (`Project.workflowId`, `defaultFor: project | subproject`). The change: the shipped workflow is the default for `subproject` only, and a top-level project may have none.
- Everything stage-driven applies to a Book alone: the editing pass Write turns on in a review stage, gate conditions (a linked manuscript, no open notes), who may move it, dashboards by stage.
- **Several Books can be open at once, each at its own stage.** Closing a Book means moving it to a closing stage (Published, Closed, On hold keep their meaning); a new Book starts in the first stage (Planning). Nothing else changes.
- **Closed Books** are hidden by default, with a *Show closed* switch, and read-only when shown (decision 8).

## 4. Scope: the one question every page asks

The **scope** is a Studio, a Project, and optionally a Book. It lives in a switcher at the top of the left rail, is remembered per Studio, and is the same for every page.

- **Project scope** is always set once a Studio has a project (the last one used, else the most recently opened).
- **Book scope** is *All books* or one Book. The default is the Book last worked in. Series-level views use *All books*.
- When a Project has only one open Book (a standalone novel, or a series with one Book open) there is nothing to choose, so the Book switcher is hidden and that Book is the scope.
- A page either **follows** the scope, **toggles** between Project and All, or is **not scoped**.

| Page | Behaviour | In a Project | Outside (All) |
|---|---|---|---|
| Home | not scoped | my work across the Studio, with the current Project first | |
| Projects | not scoped | the tree; the page for the selected Project (stays as it is, plus associations) | |
| Admin, Extensions, Settings, Profile | not scoped | | |
| Write | follows | a *Series* section (bible, characters, world) and the current Book (manuscript, outline); other Books collapsed | none: Write needs a Project |
| Notes, Files | follows, with an *All* switch | this Project's | the Studio's |
| Planner, Dashboard | toggle | this Project's Books, tasks, deadlines | the Studio's pipeline |
| My Books | toggle | this series' Books | every published Book |
| Market | toggle | only the categories assigned to this Project (and its Books' comps) | everything; used to explore before assigning |
| Finance | toggle | this series' Books | studio totals |

**Scope filters, it does not partition.** Market's library and Finance's data stay Studio-wide and nothing is moved or copied; assigning a category to a Project is a link (`ProjectLink`), which a category may have to several Projects (shared links, already built).

The toggle on a page remembers its choice per page, per Studio. A page with an empty scope says so and offers the way out ("No categories assigned to Dragon Rider. Show all categories, or assign some on the Project page.").

## 5. The Project page, brought-in things

The Project page stays as it is. It gains an **Associations** area: Market categories first, then people, comps and files. Assigning something there is what makes it appear in the Project's scope everywhere else. Books are created, opened, closed and ordered here: *Add book*, *Close book*, *Show closed*.

## 6. Skills and the assistant

| Skill | Level | Change |
|---|---|---|
| Series Developer | Project | saves into the series level (Series Bible, Characters, Worldbuilding) |
| Premise to Outline | Book | needs the Book; saves `Outline.md` and the story bible in that Book; reads the series bible first |
| Outline to Blurb, Outline to Keywords | Book | same: Book in, Book out, series canon read for voice and terms |
| Developmental, Line, Copy edit | Book | edit passes name the Book's manuscript; read series canon for continuity |
| Timeline Tracker, LitRPG Tracker | Project ledger, Book view | one ledger per series that carries across Books (decision 4); a Book view replays to a chapter or day in that Book |

- **Tools** (`list_projects`, `list_project_files`, `read_project_file`, `write_project_file`, chapters, trackers) gain an optional **book** argument. `list_projects` returns the tree with each node's level, so an assistant can see Project, Books and stages.
- **The assistant is told its scope explicitly** (decision 5): tools take a project and book; when a Project has exactly one open Book it is the default, and otherwise the skill asks which Book. The UI's selection is *not* silently followed.
- Skill text changes: where files go, which level to read, "ask which Book". Tests check each skill's saved files land at the right level.
- **Reader invitations** (Cadrel Reader) share a Book, not a Project.

## 7. Existing projects

- Nothing is moved. A project with subprojects keeps them; their kind label ("Book" by convention) is what the UI treats as a Book.
- A project with files and no Books stays a one-level project. The Project page offers **Add first book**, which moves the manuscript, outline and premise files into a new Book folder (decision 7). It never moves anything without showing the list first.
- Stages already on top-level projects are kept and shown until the person removes them; the shipped workflow stops being the default for new ones.

## 8. What was checked in the code (and what was not)

Confirmed:
- The rail is Home, My Books, Dashboard, Planner, Projects, Files, Notes, then Write, Market, Finance, Extensions, then Admin, Profile, Settings. The shell has a **selected project** (`cadrel.project`) but only the Projects page reads it.
- Write, Market and Finance are separate views the shell shows and hides; scope must reach them through the main process (Write already takes host hooks such as `projectStages` and `projectsFolder`). **Market's view has no project context today**, so Market scoping needs a new channel.
- Workflows carry `defaultFor` levels (project, subproject), which is the lever for Book-only stages. A project's `workflowId` is "null only until" it first gets one, which has to be relaxed.
- A Market category can already be linked to several Projects.
- Skills assume one project folder.

The page audit (done in Phase 1), what each shell page filters today:

| Page | Today |
|---|---|
| Notes | already has a project picker (that project and its subprojects), local to the page, default all |
| Files | search text only; no notion of a project |
| Planner | pipeline by workflow and level (all / top / sub); the calendar shows every task; no project filter |
| Dashboard | lists every project and every Market category |
| My Books | filters by pen name and text; no project |
| Home | lists the top-level projects |

So only Notes has anything to build on; the rest start from "everything", and Phase 3 adds the scope to each.

## 9. Phases

**Phase 1 is built** (the scope engine; no page follows it yet):
- `viewScope` in the kernel: what a Project and a Book are to the UI, resolving a request against the tree (an archived or deleted Project or Book never leaves the app pointing at nothing), `viewScopeOf` (the scope that shows a given record) and `inViewScope` (whether a record is inside a scope), which Phase 3's pages will use to filter. A Book that is only implied (the Project has just one) is not remembered as a choice, so a second Book brings back *All books*.
- One scope per Studio, held in the main process (`ScopeHost`), remembered in the Studio's own settings, re-checked after every change to the project tree, and announced to the shell and to every module view only when it changes.
- The shell reads and changes it (`window.cadrel.scope`: `get`, `set`, `onChange`, `openMenu`). Write, Market and Finance get a **read-only** `window.cadrelScope` (`get`, `onChange`), added to each module's preload when the shell builds it; a module cannot change the scope, which the main process enforces.
- The rail has a scope button (Project, and Book when there is more than one) that opens a **native menu**. The mock's wide selects don't fit the 64 px rail, and a list drawn in the page would be hidden behind the module views, which are native views above the page; a native menu draws above them.
- Opening a project from Home or a dashboard row makes it the scope. Browsing the tree on the Projects page does not, so looking around never changes what Write shows.
- No page filters by it yet, so the rail does not yet mark pages "project" or "all" (it would say something untrue).

Not in Phase 1: Market, Write and Finance *use* `cadrelScope` (Phase 3).

**Phase 2 is built** (the model):
- **Stage belongs to Books only.** A *Book* is a project directly under a top-level *Project*. A new Book gets the workflow that is the default "for subprojects" (the builder now calls it *default for new books*) in its first stage; a Project, or anything inside a Book, gets none, whatever is asked. Books made before workflows existed are still given the default once, and a Project is never given one.
- **A Project from before keeps its stage** until the person removes it (*Remove it* on its Books card), as decided. When it is given its first Book, the Book starts in the Project's stage and the Project is left without one.
- **Closed.** A Book is closed when its stage's category is *Done* (Published, or whatever the studio's workflow calls done). **Close book** moves it to the first Done stage its gates allow, and says what is in the way if none does; **Reopen** puts it into a chosen stage that is not a closing one. Archived Books are not "closed" (they are hidden for another reason).
- **Closed Books leave the scope** unless *Show closed books* is on (on the Project page, and in the rail's menu when the Project has any). The choice is remembered per Studio. Records inside a closed Book are outside the scope with it (`inViewScope`). A closed Book that is chosen while shown is read-only: Phase 3 enforces that in each page.
- **Standalone novels.** Making a project of kind *Standalone* makes its one Book too; the Book gets the manuscript folder and the stage. If the Book cannot be made, nothing is.
- **Add first book.** Write's project folders are flat (each tree node links to its own folder; there are no nested series and book folders), so a Project's folder is its series-level material and a Book's folder is its own. *Add first book* therefore **moves the link, not files**: the Project's manuscript folder becomes the Book's, and nothing is copied or moved on disk. The Project can then be given a series folder of its own.
- **Kind levels.** Every file kind says whether it lives at the series, the book, or either (`manuscript`, `outline`, `matter`, `brief`, `copy`, `export` are book; `premise`, `character`, `world`, `style`, `research`, `image`, `asset`, `reference` either). A studio's own kinds saved before this default to either. Nothing enforces it yet; Phase 3 uses it to place new files.
- **A race fixed on the way.** The scope's changes now run one at a time, because a refresh that began before a choice could finish after it and put the old choice back (found by the end-to-end test, reproduced by a unit test that fails without the fix).

Not in Phase 2: a separate "series" folder template (the shipped `series` and `novel` templates already differ and are the defaults for a Project and a Book), and the Planner still lists Projects (with no stage) beside Books until Phase 3.

**Phase 3 is built for Write, Market and the shell's own pages** (Notes, Planner, Dashboard, My Books, Home). **Not done: Finance and Files.**
- **The scope carries the records inside it.** `viewScopeLinks` lists, for the Project (and Book) in scope, every module record attached to it: Write folders and Market categories, each saying whether it is the series', a Book's or inside a Book, and whether that Book is closed. Records in a hidden closed Book are left out. Modules read this and never the project tree.
- **Write** (inside Cadrel) lists only the manuscripts in scope: the series' folder first, then each Book's, each card labelled; the switchers are narrowed too. A manuscript opened from Cadrel's Projects page first makes its project the scope, and when the scope moves off the open manuscript Write goes back to its list. A closed Book's manuscript is **read-only** (editor, new file, rename, delete, move), with a banner. Manuscripts that belong to no project would otherwise vanish, so Write's home always has an **All manuscripts** switch, remembered, and says how many are outside the scope. Write on its own has no scope.
- **Market** lists only the categories assigned to the Project in Queue, Library, Analysis, Keywords and the category comparison, with a header switch **Project | All**. Nothing is filtered in the library: a queue, book list or "open next" with no category chosen covers each category in scope; the search-only "uncategorised" bucket and the all-categories keyword option are left out of a Project. A Project with nothing assigned says so, with *Show all categories*.
- **Notes, Planner, Dashboard, My Books** each follow the scope with a **Project | Everything** switch remembered per page: Notes shows the Project's, its Books' and the series' own (and says how many belong to other projects or none); the Planner shows its Books' stages and its tasks and deadlines; the Dashboard its projects, manuscripts and categories; My Books its catalogue books (those linked to the Project or its Books). **Home** lists the project in scope first, marked *current*.
- **Closed Books** drop out of every one of these unless *Show closed books* is on.
- **Found on the way:** a page that mounted after the scope was known showed everything for a moment while it asked again; the window now keeps the last scope heard. And five older end-to-end tests assumed every project and category was visible; they now say so explicitly (switch to All) or wait on Write's landmark, not its heading.

**Not done in Phase 3**
- **Finance.** Its figures are aggregated inside the library's queries, so scoping it means those queries taking a set of books (by ASIN), not a filter in the page. The scope would need to carry the Project's ASINs (from the catalogue's book links); neither exists yet.
- **Files.** The vault is its own working folder (`<Studio>/Vault`) with no link to the project tree, so there is nothing to scope it by until files are attached to projects.
- **My Books' Market-only list** (used where this computer has no catalogue records) has no project to filter by.
- **Per-Book Market categories.** Categories are assigned to the Project; a Book in scope shows the Project's categories.

**Phase 5 is built** (the assistant: tools and skills):
- **Naming a Project and a Book.** Every tool that takes a `project` also takes `book`. The assistant names the Project (a name, path or id) and a Book of it (a name, or the start of one: "Book 2" finds "Book 2: Ash"; "Dragon Rider / Book 3" works too); a plain manuscript folder name from `list_projects` still works, so nothing that is not in a project is lost. It is told explicitly and the tools never follow what is open in the app.
- **When it is unclear, the tool says what to ask.** Book-level work (manuscript, notes, outline, blurb, keywords, trackers) on a Project with several open Books answers "Dragon Rider has 2 open books (…). Say which one with `book`" and offers only open ones. With exactly one open Book (a standalone novel, or a series with one left open) that Book is the default. Series-level material (`list_project_files`, `read_project_file`, `write_project_file`, `edit_project_file`) named for the Project alone goes to the **series' own folder**; with `book` it goes to the Book's. A project that has no Books yet keeps working as one level.
- **Closed Books are read-only to the assistant.** Reads work; notes, file writes and tracker logs are refused ("Book 1 is closed… reopen it in Cadrel"). "Closed" is the app's own rule (a Done stage), shared through `closedBookIds` in the kernel; it needs the Studio's records, which the app always passes, so a server started without them cannot tell and treats nothing as closed.
- **`studio_projects` says what each node is** (Project or Book, its stage, closed, and the manuscript folder to use), and a new **`studio_context`** gives one Project and Book whole: the series files to read first, the Book's own files, the other Books with stages, and where new work belongs, or "ask which Book".
- **Skills.** The series developer works at the series level and leaves `book` out. The outline, blurb and keywords skills work on one Book: they read the series files first, pass `book`, and save in the Book. The three editing passes review one Book and read the series material first (their shared section is still identical, as a test requires). The two trackers work one Book at a time. Tests pin each skill's level in its text, and the assistant tests prove where files actually land.
- **Trackers across Books, differently from the spec.** The spec said one ledger per series. Instead each Book keeps its own ledger, and the LitRPG state, checks and views **read it with the earlier Books' in front** (their events placed at "chapter 0"), so a character starts Book 2 where Book 1 left them and a jump between Books is flagged, while logging stays per Book and nothing is copied between ledger files. This keeps every ledger and view in the format it already has. Checks over the joined ledger only keep flags that touch the Book being read. **The timeline ledger is not carried:** its day count and chapter anchors are each Book's own, and the skill says to state the starting day when days continue across Books.

**Not done in Phase 5**
- Reader invitations per Book: an invitation already shares one manuscript folder, which is a Book's, so there was nothing to change; the series folder can also be shared.
- A carried timeline, and one shared ledger file per series. *(Built. A series with a folder of its own keeps `Tracking/LitRPG Ledger.json` and `Tracking/Timeline Ledger.json` there, `{ series_ledger: 1, books: { <book id>: { name, ledger } } }`. Chapter numbers stay each Book's own; the Books before this one are read from the same file and put in front at "chapter 0", so a character starts a Book where the last one left them, the days continue and a Book that opens before the last ended is flagged. A Book that kept its own file before is read from it, and its next save moves it into the series file. A series with no folder of its own, or a book on its own, keeps one file per Book as before.)*
- Tools to add a Book or close one from the assistant (it can still organise projects with the existing studio tools; closing is a gated workflow move that stays in the app).

The plan:

0. **This spec and the mock.** Agree the rules.
1. **Scope engine.** Audit the pages' existing filters. One scope (Studio, Project, Book) in the shell, the rail switcher, persistence per Studio, and a way to pass it to Write, Market and Finance. No page changes yet.
2. **Model.** Stage on Books only; series versus book kinds and templates; Add / Close Book; *Add first book* for existing projects.
3. **Pages, one at a time.** Write, then Market (toggle and category assignment), then Notes, Files and Planner, then Dashboard, My Books, Finance, Home.
4. **Associations** on the Project page. *(Built: Market categories and manuscripts, each for the whole Project or one Book. People, comps and files wait for the pages that could use them.)*
5. **Skills and tools.** Book argument, rewritten skills, tests that they save at the right level; trackers on a series ledger.
6. **Migration, Reader per Book, docs, tests throughout.** *(Done. Migration: nothing is moved or copied. A project with a stage keeps it until removed; **Add first book** hands the manuscript folder to the new Book as a link, and a Book made before workflows existed is given the default workflow in the stage it had (`stages.test.ts`). Reader: an invitation shares one Write manuscript folder, which belongs to a Book, so it is per Book already; the series folder can also be shared. Every phase added tests as it was built.)*

**Where things stand.** Built: 1 scope engine, 2 model, 3 pages (Write, Market, Notes, Planner, Dashboard, My Books, Home), 4 Associations (Market categories, manuscripts, comparable titles and people), 5 skills and tools, 6 migration and docs, and the series ledgers: one LitRPG file and one timeline file per series (in the series' own folder, each Book's ledger inside under its id), with the earlier Books carried in front when a Book is read or checked. Not built: Finance and Files following the scope (left out on purpose).

Each phase ends in something a person can use, and none changes stored data except Phase 2 (stage rules) and *Add first book* (shown and confirmed first).

## 10. Decisions taken

1. A standalone novel is a Project with one Book.
2. A Project has no stage (active or archived only).
3. Books may add their own series-style files; series files apply to every Book.
4. Trackers carry across Books in a series.
5. The assistant is told the project and book explicitly.
6. Market categories are assigned to the Project, with an optional per-Book override: a category assigned to one Book shows in that Book and in the Project, not in the other Books.
7. Existing projects without Books are left alone, with an *Add first book* action.
8. Closed Books are hidden by default and read-only when shown.
