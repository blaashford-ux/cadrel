---
name: cadrel-outline-to-blurb
description: "Turns a story bible or chapter outline into a spoiler-free Amazon sales blurb: a short narrative with a hook, setup, challenge, love interests and call to action, followed by a compact structured block of tropes, heat level, tone, POV, ending type, series info and comp titles for shoppers and for Amazon's AI shopping and search layer. Saves it as Marketing/Blurb.md. Use when the user wants a book description, back-cover copy or Amazon listing blurb for a project that has an outline or story bible, and the Cadrel project tools (list_project_files, read_project_file, write_project_file) are available. Writes sales copy only, never manuscript prose."
---

# Outline to Blurb (Cadrel)

Converts a story bible and outline into a genre-conventional sales blurb: a narrative hook and premise for human readers, then a structured trope and metadata block for Amazon's AI shopping layer and for skimming readers. Spoiler-free by design. The blurb sells the premise and the first-act stakes, never the resolution. It is sales copy only; it never writes or changes manuscript chapters.

## Working in Cadrel

You have Cadrel's project tools. A project is a folder of Markdown files.

1. **Find the project.** `list_projects`; if it isn't clear which one, ask.
2. **See what exists before you create anything.** `list_project_files` shows every file with its kind (premise, outline, character, world, ...). `read_project_file` reads one; a long file comes in parts, so pass `start` to continue. What the author has already written outranks your defaults.
3. **Save what you make.** `write_project_file` creates a file. It never touches the manuscript, never replaces an existing file unless you pass `mode: "replace"` (the previous version is kept), and can't leave the project folder. Use `edit_project_file` for a small exact change.
4. **Manuscript chapters** are read with `list_files`, `list_chapters` and `read_chapter`. You cannot change them.

If these tools aren't available, work in chat and give the finished blurb in a code block for the author to copy.

## Step 1: Gather what the story bible has

Read the project's outline or story bible (and premise and character files if there are any) for: premise, protagonist(s), core conflict, main characters (especially love interests and the found-family cast), setting, tone and themes, POV plan and ending target. That covers most of the narrative directly.

## Step 2: Get what the story bible doesn't have

The bible holds no marketing metadata. Ask only for what is genuinely missing, in one short round; tone and POV are usually in the bible, while heat level and trope tags almost never are:

- **Heat level** (Clean, Sweet, Steamy, Explicit).
- **Genre trope tags**, the bullet keywords a shopper or an AI assistant searches on ("Progression Fantasy", "Found Family", "Weak to Strong", "Fake Dating"). Get the real list from the author rather than guessing at conventions.
- **Series status:** standalone or series, book number, ongoing or complete.

**Comp titles are different: propose, don't just ask.** Propose up to six real, current, genre-accurate comp titles for the project's actual subgenre and tropes ("dungeon core progression fantasy harem", not just "fantasy romance"). Use web search if you have it. If you don't, propose from what you know and tell the author these are unverified and should be checked. They must be real books; never invent a title. Present the list and let the author confirm, trim or swap before it goes in the blurb.

## Step 3: Draft spoiler-free and tight

The blurb covers the premise and first-act stakes only: never the ending, never a mid- or late-book twist, never how the central conflict resolves. See **Blurb anatomy** below for why spoiler-free converts better.

**The narrative section follows exactly five beats, in order, and stays lean.** It is read in seconds; it is not a short story.

1. **Hook:** 1 to 4 lines.
2. **Setup:** the protagonist and their world or status, one tight paragraph.
3. **Challenge faced:** the inciting conflict, threat or goal, one tight paragraph.
4. **Women:** the love interests or harem, each named with one distinguishing trait, in one paragraph, not a cast breakdown.
5. **Call to action:** a short closing line that ends the narrative section (separate from the comps and CTA line that closes the structured block).

No separate tension or secret line, and no genre-blend tagline, as their own paragraphs. If either has content worth keeping, fold the sharpest phrase into Challenge faced or Women. Each beat defaults to 2 to 4 sentences; if one runs longer, cut before adding.

**Offer 2 or 3 hook-line variants first.** The opening lines are the highest-leverage part of the blurb. Present the variants and let the author pick or combine before you write the rest around the chosen hook.

## Step 4: The structured block is for Amazon's AI as much as for people, and it is tight too

The block below the narrative is what an AI shopping assistant parses for intent-matching (genre, tropes, heat level, comps), and current guidance is that these systems favor clean, specific, natural-language attributes over keyword-stuffed prose. Use tropes under their real, commonly searched names ("Dungeon Core Adjacent", "Slow Burn", "Enemies to Lovers"), not paraphrases or invented variants.

Keep it compact: trope bullets of a phrase, not a sentence; one-line metadata fields; and one comps and CTA line at the end with up to six confirmed comps. If a bullet needs more than a few words, it is probably two tropes or the wrong level of detail.

## Step 5: Save

Save `Marketing/Blurb.md` with `write_project_file`; it is a standalone piece of marketing copy meant to be pasted into a KDP listing, so don't leave it only in chat. If hook variants aren't chosen yet, save the full set at the top of the file so the author can pick, then update the file (`edit_project_file`) once they have. If the file exists, don't overwrite it: ask whether to replace it (the old version is kept) or save another under a new name.

File layout:

```markdown
# Blurb: [Title]

[Hook, 1-4 lines]

[Setup]

[Challenge faced]

[Women]

[Call to action]

---

- [Trope]
- [Trope]
- ...

**Heat Level:** ...
**Tone:** ...
**POV:** ...
**Ending:** [type only, never what happens]
**Series:** [book number, ongoing or complete]

[Comp 1], [Comp 2], ... Start reading [Title] today. / Continue the [Series] series today.
```

---

## Blurb anatomy

**The five beats**

1. **Hook (1-4 lines).** An 8-second scan decides whether a browser keeps reading. Often first person, present tense, direct address in this genre ("They came to my world. They took my father. They gave me nothing."). It ends on defiance, a question or an irreversible decision. It never explains the plot; it creates a feeling and a question.
2. **Setup.** Pattern: "[Name] is [status or role] in a world of [genre context]." Who and where, not what happens next.
3. **Challenge faced.** The inciting incident and central conflict, threat or goal: what kicks the story into motion and what is at stake, never how it resolves.
4. **Women.** Love interests named with one distinguishing trait or role each, in a single paragraph. Fuller detail belongs in the trope bullets or nowhere.
5. **Call to action.** The narrative's own landing line, not a restatement of the structured block's closer.

**The structured block**

- Trope bullets (a phrase each) in real searched terms.
- Heat Level, Tone, POV, Ending: one line each. Ending stays spoiler-free, the *type* ("Series-continuing with resolution"), never what happens.
- Series info: one line.
- Comps and CTA: one line, up to six confirmed comps, then a short CTA ("Start reading [Title] today" or "Continue the [Series] series today"). This is the block's only CTA, and it shouldn't repeat the narrative's closer verbatim.

**Spoiler-free discipline**

- State the inciting incident, not how the central conflict resolves.
- Name threats and stakes, not outcomes.
- If a detail would spoil a mid- or end-book twist, leave it out even if it is a strong hook candidate. A spoiler that boosts one blurb's punch costs more in reader trust than it gains.

**Writing for Amazon's AI layer.** Keyword-stuffed, unnatural phrasing is penalized, not rewarded; the system favors clean, specific language that answers a shopper's real intent. Write the narrative as real marketing prose and keep it short, since length works against its scan-and-decide job. Let the structured block do the attribute matching (tropes, heat, comps) instead of cramming those terms into the narrative, and prefer specific trope names to generic labels ("Dungeon Core Adjacent" beats "Fantasy Adventure").

**Worked reference** (a progression-fantasy exemplar mapped to the five beats): the hook is four short first-person lines ending on a defiant one-line decision ("Screw that."); the setup is one sentence ("a peak human playing in a world of superhumans"); the challenge is the sacrifice and waking up with an Interface, stated without resolution; the women are the Healer and the sister's best friend, named by role and kept brief; the call to action is a "keeping secrets from everybody" line that lands the section instead of sitting as its own tension paragraph; then the bullet tropes, Heat Level, Tone, POV, Ending, and comps with CTA, each line compact.
