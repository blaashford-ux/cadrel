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

Not in Phase 1: Market, Write and Finance *use* `cadrelScope` (Phase 3), closing a Book (Phase 2, so "open Book" today means "not archived").

The plan:

0. **This spec and the mock.** Agree the rules.
1. **Scope engine.** Audit the pages' existing filters. One scope (Studio, Project, Book) in the shell, the rail switcher, persistence per Studio, and a way to pass it to Write, Market and Finance. No page changes yet.
2. **Model.** Stage on Books only; series versus book kinds and templates; Add / Close Book; *Add first book* for existing projects.
3. **Pages, one at a time.** Write, then Market (toggle and category assignment), then Notes, Files and Planner, then Dashboard, My Books, Finance, Home.
4. **Associations** on the Project page.
5. **Skills and tools.** Book argument, rewritten skills, tests that they save at the right level; trackers on a series ledger.
6. **Migration, Reader per Book, docs, tests throughout.**

Each phase ends in something a person can use, and none changes stored data except Phase 2 (stage rules) and *Add first book* (shown and confirmed first).

## 10. Decisions taken

1. A standalone novel is a Project with one Book.
2. A Project has no stage (active or archived only).
3. Books may add their own series-style files; series files apply to every Book.
4. Trackers carry across Books in a series.
5. The assistant is told the project and book explicitly.
6. Market categories are assigned to the Project, with an optional per-Book override (not designed here; Phase 4).
7. Existing projects without Books are left alone, with an *Add first book* action.
8. Closed Books are hidden by default and read-only when shown.
