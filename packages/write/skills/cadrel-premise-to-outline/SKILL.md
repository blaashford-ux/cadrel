---
name: cadrel-premise-to-outline
description: "Turns a story premise (a sentence, a pitch, a brain-dump, character sheets, or a partial outline) into a full chapter-by-chapter outline in three acts, with a story bible, detailed enough that each chapter entry alone can drive a drafting pass, and saves it as Outline.md in the project. Genre-neutral by default; applies genre conventions only when the premise signals them. Use when the user wants to outline a novel, story or serial, break a premise into chapters, plan a book, or expand a rough outline to chapter-level beats, character states and hooks, and the Cadrel project tools (list_project_files, read_project_file, write_project_file) are available."
---

# Premise to Outline (Cadrel)

Converts a premise into a two-part deliverable, a **story bible** (reference) and a **chapter-by-chapter outline** (the working document), structured in three acts and detailed enough that each chapter entry could drive a drafting pass without the author re-explaining the story each time.

## Core principle: write for the next drafting pass, not for a human skimming

Assume the reader of every chapter entry (the author, or an AI asked to draft from it) has **no other context** than the story bible and that one entry. No vague beats ("something happens with the rivalry"), no unresolved pronouns, no "TBD". Name names, name places, name the emotional change. If a detail isn't decided, invent a consistent one and say so; the author can swap it later.

**A subtler failure: content that is abstracted rather than vague.** A beat can name real people and places and still fail if the one thing that needed to be concrete (the wording of an offer, a line of dialogue, a document's title, a number, a precedent) is replaced by a category label describing its shape. It reads as specific on a skim and hands the drafter nothing.

- **Fails (abstracted, not vague):** "He receives increasingly personal offers from Houses, some well outside anything he expected." It names an event and a register, and still says nothing about what was said.
- **Passes (the instance, invented if undecided):** "House Ferro's matriarch offers her candidate with the specific promise that she 'comes with no restrictions of any kind' and that he 'can have whatever he wants from her, however he wants it', in the brisk tone someone might use to list a property's amenities."

When a beat involves an offer, threat, decision, document or piece of dialogue that matters, write the actual line or artifact.

## Working in Cadrel

You have Cadrel's project tools. A project is a folder of Markdown files.

1. **Find the Book.** In Cadrel a project is a series with Books under it, and this work is for **one Book**. If `studio_context` is available, call it with the project (and `book`): it lists the series-level files to **read first** (the series bible, characters, worldbuilding, style sheet, series premise) and the Book's own files. When the project has several open Books, pass `book` on every call, and if it isn't clear which Book, ask; the tools will ask you too. A closed Book is read-only: you can read it, not change it. Without `studio_context`, use `list_projects`; if it isn't clear which one, ask.
2. **See what exists before you create anything, starting with the series.** `list_project_files` shows every file with its kind (premise, outline, character, world, ...): call it for the series (no `book`) and for the Book. Read the series-level files first with `read_project_file` (a long file comes in parts, so pass `start` to continue), and keep this Book's work consistent with them: what the series bible and the author's own files say outranks your defaults, and this work never changes the series level unless the author asks.
3. **Save what you make in the Book.** `write_project_file` creates a file in this Book's folder (pass the same `book`), not the series'. It never touches the manuscript, never replaces an existing file unless you pass `mode: "replace"` (the previous version is kept), and can't leave the project folder. Use `mode: "append"` to add to a file you started, and `edit_project_file` for a small exact change.
4. **Manuscript chapters** are read with `list_files`, `list_chapters` and `read_chapter`. You cannot change them.

If these tools aren't available, do the same work in chat: give the outline in sections and say where it belongs.

## Workflow

### Step 1: Intake

**First, look for existing project files:** a premise, a series bible, character files, worldbuilding files (`list_project_files` shows them by kind). If they exist they are authoritative: read them instead of asking the author to re-explain, and build the story bible from them. Character files map directly onto the bible's Main Characters section rather than being re-summarized loosely.

If none exist, accept the premise in whatever shape it comes, a sentence, a pitch, bullets, sheets, a partial outline, vibes. Don't demand a clean brief; extract what you can and fill gaps with stated inventions.

Then ask, in one round, only for what you need and can't reasonably infer:

- **Total word-count target.** Always ask. It is the authoritative number the outline and every later chapter target against; never infer it silently and never skip it because other files exist, since they don't cover it.
- **Preferred chapter length.** Always ask, as its own question. It is an aim point for the book's average, not a binding per-chapter number (see Step 2). Suggest a genre-appropriate default if the author has no preference: longer for literary or character-driven work, shorter for fast-paced, serial or LitRPG-style work.
- Anything load-bearing that is genuinely ambiguous or missing: the premise implies several POV characters but not whether the book rotates; the ending type is unclear (closed or open/serial); a core relationship's nature is unclear. Don't ask about what you can invent (minor names, setting flavor, chapter titles) or what the files already answer.

Don't over-interview. One round of targeted questions is the ceiling; everything else gets a stated assumption.

### Step 2: Chapter count, and beat sufficiency per chapter

- Minimum chapter length is **1,800 words**. Never plan a shorter chapter.
- Divide the total target by the preferred chapter length to get a chapter count. Individual chapters land above or below the average depending on what they need.
- State the resulting count as a one-line assumption and proceed without asking. If it is very unusual (4 chapters, or 120), flag it: it may signal a word-count and scope mismatch.

**Beat-sufficiency check, per chapter, while writing the beats.** A chapter defaults to 5 beats, each with a native range of 300 to 1,000 words once dramatized. That is a real ceiling on what a beat's written description can support, so check both ends:

1. The beat list supports `beats x 300` to `beats x 1,000` words.
2. **Target inside that range** (the normal case): proceed. A genuinely complex beat may run toward 1,000.
3. **Target above the maximum:** that, and only that, is the trigger for a 6th beat. Never the first response to "this needs to be longer"; exhaust the range on the existing beats first.
4. **Target below the minimum:** the chapter doesn't need five beats' worth. Flag it rather than pad.

**Before writing a chapter's beats, compute its per-beat average and state the tier.** Divide the chapter target by its beat count (a ~2,700-word chapter with 5 beats averages 540). The average falls in one of three tiers, and each beat should meet that tier's element floor unless another beat compensates:

- **Compact (300-500):** one clean idea.
- **Mid (500-750):** at least two distinct concrete elements in the beat's own description, such as an action plus a complication, or an event plus the specific dialogue or decision it turns on.
- **Dense (750-1,000):** three or more: a physical action, a complication or obstacle, and a specific emotional or relational turn.

If a beat doesn't honestly have that much distinct material, don't write it as if it does and hope the drafter invents the rest; that only relocates the padding. Write the specifics in now, or give the beat less weight and let another beat (or the 6th-beat fallback) carry more.

**Tally each chapter's beats against its tier right after drafting them, before the next chapter.** One line each is enough: "beat 3, mid tier, 2 elements: the refusal, the specific cost, pass" or "beat 4, mid tier, 1 element, rewrite now". Do it per chapter as you go; across a long outline this standard is the first thing to erode, and it is far cheaper to catch immediately.

### Step 3: Build the story bible

Always produce it, even for a rich premise. It is the reference sheet every chapter entry points back to. Draft it, then pause only if something is genuinely ambiguous, load-bearing and missing; otherwise present it as done and go straight on to the outline.

**If premise, bible or character files exist, the bible is a condensed pointer to them, not a re-derivation.** Pull main characters from the character files (love interests and harem dynamic included), world rules from the worldbuilding files, tone, themes and core conflict from the premise.

Required sections (template and a worked example follow):

1. **Premise restated:** 2 to 4 sentences confirming your read.
2. **Core conflict:** the central dramatic question.
3. **Main characters:** name, role, want, need (if different), flaw or wound, arc (start to end, emotionally and relationally), one distinguishing voice or behavior trait.
4. **Setting and world rules:** place, time, any speculative rules the outline must stay consistent with.
5. **Tone and themes:** 2 or 3 words of tone, 1 or 2 sentences of theme.
6. **POV plan:** single or rotating; if rotating, whose and how.
7. **Ending target:** closed, cliffhanger or serial-open, or series setup, and in broad strokes what it is.

### Step 4: Three-act structure

Proportions are flexible; don't force 25/50/25. **Always label the act breaks explicitly** (which chapter starts Act II, which starts Act III) and give a one-paragraph statement of what each act is doing dramatically (setup and inciting incident, rising complication and midpoint turn, climax and resolution), naming this story's actual turning points, not the structure in the abstract. If the story is open-ended or serial, still use three acts as the shape of this volume's arc, and say so rather than forcing false closure.

### Step 5: The chapter-by-chapter outline

Every chapter gets an entry in the format below. Work in order, act by act, so later chapters can reference earlier setups. Keep a running list of open threads and planted setups, and before finishing check that every major thread opened is addressed by the ending target.

Each entry needs:

- Chapter number, working title, an act label (only on chapters that open an act), POV character, target length.
- **Beats:** the ordered concrete events, specific enough to write from. Not "the two argue" but what about, what is said or done that changes something, how it ends. Apply the Step 2 check while writing them, not after.
- **Character states:** for every character with meaningful presence, their emotional or relational state entering and the change by the end. For anyone other than the chapter's POV character this tracks continuity; it is not license to dramatize their interior. A non-POV character's change should be something the POV character can plausibly observe or infer in the scene, or be flagged to land in that character's own POV chapter.
- **Setting:** where and when.
- **Threads touched:** which plot, subplot and relationship threads this advances, and how.
- **Chapter hook:** what pulls the reader into the next chapter (a question, cliffhanger, reveal or decision), phrased as something the *current* POV character perceives, hears, is told or realizes. In a rotating-POV book never write the hook as a moment inside the next POV character's head; drafted literally, that is a POV violation.
- **Continuity notes:** what this sets up or pays off that another chapter has to match.

### Step 6: Assemble and save

**Before the final save, re-scan the whole chapter list once as a dedicated QA pass.** This is not the per-chapter tally. It is a second look across the finished document for beats that read as a single vague clause or a single abstracted category despite passing the local check. Chapters written late in a long sequence are the likeliest place for the standard to have slipped. Fix what fails before delivering.

Save one Markdown file, `Outline.md` at the project root (or the name the author prefers), in two sections: `## Story Bible & Reference`, then `## Chapter Outline`. A long outline is too much for one call, so build it in parts: create the file with the bible, the act summaries and Act I, then `append` each later act with `write_project_file` (`mode: "append"`). If an outline already exists, don't overwrite it; ask whether to replace it (the old version is kept) or write alongside it under a new name.

When done, tell the author in a few lines where it is, the chapter count and act breaks, and offer revisions to specific chapters, a chapter-count or pacing change, or a deeper pass on any one chapter. Outlines are meant to be iterated on.

## Handling revisions

To revise part of an existing outline (a chapter, an act, an arc), `read_project_file` it, then change only the affected entries and any downstream entries whose continuity depends on the change (setups, hooks, character-state changes). Re-check the continuity chain forward from the edit. Use `edit_project_file` for each change rather than rewriting the file, unless the change is structural (chapter count, act boundaries), in which case regenerate the affected range.

---

## Template: story bible

```markdown
## Story Bible & Reference

### Premise
[2-4 sentences restating the story]

### Core Conflict
[The central dramatic question]

### Main Characters

**[Name]**: [Role, e.g. protagonist, antagonist, love interest, mentor]
- Want: [external goal]
- Need: [internal need, if different]
- Flaw/Wound: [what is broken or holding them back]
- Arc: [state at start] -> [state at end]
- Voice/behavior trait: [a verbal tic, a habit, a contradiction]

[Repeat for each main character]

### Setting & World Rules
[Place, period, and any magic, tech, social structure or factions the outline must stay consistent with]

### Tone & Themes
- Tone: [2-3 words]
- Themes: [1-2 sentences on what the story is about under the plot]

### POV Plan
[Single, or rotating: whose, and the rough pattern]

### Ending Target
[Closed / cliffhanger-open / series-setup, and in broad strokes what happens]
```

**Worked example.** Premise: *"A disgraced knight tries to clear her family's name after being framed for treason."*

```markdown
## Story Bible & Reference

### Premise
Seren Voss, once captain of the royal guard, was stripped of rank and exiled after being framed for conspiring against the crown. Three years later, evidence surfaces that her former mentor orchestrated the frame-up to seize her family's ancestral seat. Seren must infiltrate the capital she is forbidden to enter, gather proof, and confront the man who destroyed her life without becoming the traitor she was accused of being.

### Core Conflict
Can Seren reclaim her name and her family's honor without compromising the code of loyalty that made her worth framing in the first place?

### Main Characters

**Seren Voss**: protagonist
- Want: Clear her name and reclaim her family's title.
- Need: Learn that her worth isn't tied to rank or the crown's approval.
- Flaw/Wound: Rigid loyalty to institutions that already betrayed her once.
- Arc: Believes vindication means restoration to the old order -> chooses her own code over the crown's approval, reinstated or not.
- Voice/behavior trait: Counts things under her breath when anxious, a habit from drilling recruits.

**Lord Commander Aldric Thane**: antagonist, Seren's former mentor
- Want: Consolidate the Voss lands and seat under his own house.
- Need: (none; he is past self-correction)
- Flaw/Wound: Believes the kingdom is safer consolidated under strong hands like his. A true believer, not a cartoon.
- Arc: Confident and untouchable -> exposed but unrepentant, forcing Seren to decide his fate herself.
- Voice/behavior trait: Never raises his voice; delivers threats in the tone of pleasantries.

**Mira Calloway**: deuteragonist, a smuggler who owes Seren a debt
- Want: Pay off the debt and be done with Seren's mess.
- Need: To let herself care about someone again after losing her crew.
- Flaw/Wound: Treats every relationship as a transaction.
- Arc: Reluctant ally -> genuine loyalty, the first person in years she'd risk her neck for.
- Voice/behavior trait: Deflects sincerity with jokes; drops them entirely in the one or two moments she means something.

### Setting & World Rules
Kingdom of Velmoor, low fantasy, medieval-adjacent, no magic. The capital, Aldenreach, is walled; Seren is under a standing exile order punishable by death if she is caught inside. Noble houses hold hereditary seats that can be seized by royal decree if a house is convicted of treason, the mechanism Thane exploited.

### Tone & Themes
- Tone: tense, wry under pressure, morally clear-eyed but not black-and-white
- Themes: What loyalty is owed to an institution versus the people it is meant to protect; the difference between vindication and belonging.

### POV Plan
Single POV, third-person close on Seren throughout.

### Ending Target
Closed ending. Seren exposes Thane publicly but refuses to let the crown quietly execute him to save face; she forces a public trial, at the cost of not being fully reinstated. She leaves the capital on her own terms, with Mira, having redefined honor.
```

## Template: chapter entry

```markdown
### Chapter [N]: [Working Title] [- ACT I / ACT II / ACT III BEGINS, only on act-opening chapters]

**POV:** [Character] | **Target length:** ~[X,XXX] words

**Beats:**
1. [Concrete event: who does what, what is said or decided, what changes]
2. [...]

**Character states:**
- [Character]: enters [state] -> exits [new state, and what caused the shift]

**Setting:** [Where and when]

**Threads touched:** [Which threads this advances, and how]

**Chapter hook:** [What pulls the reader on, perceived by the current POV character]

**Continuity notes:** [What this sets up for later chapters or pays off from earlier ones]
```

**Worked example** (continuing the Seren Voss story):

```markdown
### Chapter 6: The Wall at Night - ACT II BEGINS

**POV:** Seren Voss | **Target length:** ~2,400 words

**Beats:**
1. Seren and Mira reach Aldenreach's east wall after dark, using a smuggler's drainage tunnel Mira's old crew ran contraband through; it is half-collapsed, forcing them to go slower and louder than planned.
2. A night patrol nearly finds them; Seren freezes and counts under her breath rather than acting, and it is Mira who improvises a distraction, the first crack in Seren's assumption that she is still the more capable one.
3. Inside the walls they reach a safehouse kept by Seren's old quartermaster, Old Dunmore, who is stunned to see her alive and refuses to let them stay, afraid of being implicated.
4. Seren makes her case not as a captain giving an order (her old instinct) but as a person asking for help, a deliberate choice, and it is what changes Dunmore's mind, not rank.
5. Dunmore agrees to hide them for one night and gives the first concrete lead: Thane has been buying up debt notes on minor houses near the Voss lands, consistent with a slow land-grab rather than a one-off frame job.

**Character states:**
- Seren: enters framing this as a mission to execute with military precision -> exits shaken that her instincts (freeze, command) aren't working, and grudgingly aware she needs Mira and Dunmore as people, not resources.
- Mira: enters performing reluctance ("I'm only here for the debt") -> exits having acted on instinct to save Seren, a beat she brushes off with a joke that the reader should read as the first real crack in her transactional stance.
- Old Dunmore: enters fearful and self-protective -> exits choosing loyalty to Seren over his own safety, motivated by guilt over not speaking up three years ago.

**Setting:** Aldenreach's eastern slums, a collapsed smuggler's tunnel, and Dunmore's safehouse above a shuttered tannery. Night.

**Threads touched:** Main investigation (first concrete lead on Thane's land-grab); Seren and Mira (trust shift); Seren's internal arc (command instincts failing her).

**Chapter hook:** Dunmore's list of debt notes includes a name Seren doesn't expect, a house she thought neutral, possibly her family's last ally, now compromised.

**Continuity notes:** Sets up the debt-notes lead chapters 7 to 9 follow. Plants that Seren's freeze-and-count response is unreliable under real pressure, which should pay off when she consciously overrides it in Act III. Decide the specific house on Dunmore's list now and keep it consistent.
```

## Beat density calibration

The example sits at the compact-to-mid end (beat 2 already reaches mid by stacking the patrol near-miss, Seren's freeze, Mira's distraction and the arc-turn). Here is beat 3 at each tier, same events.

**Compact (300-500), one clean idea:**
> 3. Inside the walls they reach a safehouse kept by Seren's old quartermaster, Old Dunmore, who is stunned to see her alive and refuses to let them stay, afraid of being implicated.

**Mid (500-750), two elements, an event plus a complication:**
> 3. Inside the walls they reach a safehouse kept by Seren's old quartermaster, Old Dunmore, who is stunned to see her alive and refuses to let them stay, afraid of being implicated. He has already lost his commission once for association with her, and a second time would cost him the tannery he has rebuilt his life around.

**Dense (750-1,000), three or more elements:**
> 3. Inside the walls they reach a safehouse kept by Seren's old quartermaster, Old Dunmore, who is stunned to see her alive and refuses to let them stay, afraid of being implicated. He has already lost his commission once for association with her, and a second time would cost him the tannery. Mira, out of patience and options, tries to bribe him with what little coin they have left; he is insulted rather than persuaded, and the attempt nearly gets them turned out onto the street before Seren can recover it. Only when Dunmore notices the same freeze-and-count habit from her command days, worse than he remembers, does his fear tip into something closer to pity, and it is pity, not persuasion, that gets them through the door.

The dense version doesn't describe the same handshake at greater length. It adds three separate things happening in sequence: the refusal and its real stakes, a failed bribe that makes things briefly worse, and a specific observation that actually changes his mind. A beat earns 750 to 1,000 words only with that much distinct material.
