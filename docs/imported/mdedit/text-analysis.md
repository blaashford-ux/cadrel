# Text analysis (0.7)

**Right-click a file → Analyze Text.** MDEdit reads the file (using the unsaved text of the chapter you have open), works through it a chapter at a time so the editor stays responsive, and then writes `<name> - Analysis.md` in the same folder. The report opens in a new tab next to the file's tab; focus stays where it was. A second run writes `… Analysis 2.md` and so on, so you can compare drafts.

The report is a Markdown file, so it lives in the project, syncs like any other file, and can be annotated or deleted. In MDEdit it opens as a **formatted report page** (charts, tables, hover tooltips on every bar and square, light and dark). The toolbar above it has **Save as HTML** (one self-contained page you can open in any browser or send to someone), **Save as PDF** (desktop app), and **Edit as Markdown**, which shows the file's text; a **Report** button in the editor toolbar goes back. The Markdown is complete on its own too: the same numbers as tables and block-character charts.

The page is drawn from the results stored in a one-line `<!-- mdedit-analysis v1 {…} -->` comment at the very end of the file (it adds nothing to the word count). Delete that line and the file simply opens as ordinary Markdown. Edit the rest of the text freely; the formatted page always shows the stored results, so re-run the analysis after editing the manuscript. Every major section is a heading at the project's chapter level, so each section appears as a "chapter" in the file list. In the Markdown text, charts are drawn with block characters inside code blocks.

## What it measures

| Section | What you get |
|---|---|
| Summary | Key numbers and a short "worth a look" list drawn from the rules of thumb below |
| Overview | Words, unique words, sentences, paragraphs, chapter-length chart, a per-chapter table, pacing sparklines |
| Dialogue | % of words that are spoken, % of paragraphs with dialogue, dialogue by chapter, speech-tag verbs (plain "said" vs. showy tags), tags carrying adverbs |
| Sentences and rhythm | Average, median and spread of sentence length, length histogram, paragraph-length histogram, longest sentences, sentence openers and runs of the same opener |
| Reading level | Flesch Reading Ease, Flesch–Kincaid, Gunning Fog, Coleman–Liau, ARI, SMOG, their average, and grade by chapter |
| Repeated words | Most-used content words (common words and names removed), and *echoes*: the same word twice within about 25 words |
| Repeated phrases | Two- and three-word phrases that recur |
| Adverbs | "-ly" adverbs per 1,000 words, the commonest, by chapter |
| Passive voice | Share of sentences, how many name the doer ("by…"), by chapter, examples |
| Filler, filter and crutch words | Filler/hedge words (just, really, very, quite…), filter words (felt, seemed, saw, began to…), stock gestures (nodded, shrugged, took a deep breath…), "that" that can probably be cut, per chapter |
| Point of view and tense | Person and tense of the book and of each chapter, chapters or paragraphs that break them, whose thoughts each chapter reports, possible head-hopping within a scene |
| Characters | Auto-detected names with mentions, chapters, first appearance, dialogue lines tagged to them, and a who-appears-where heat map |
| Punctuation habits | Exclamation marks, question marks, ellipses, em dashes, semicolons, colons, parentheses |

## How it decides

- **Prose only.** Headings, scene breaks (`* * *`, `---`), HTML comments, code blocks, tables and YAML front matter are ignored. Emphasis markers are stripped.
- **Dialogue** is text inside double quotes (straight or curly). A quotation that continues into the next paragraph (opened again with a quote mark) is followed across the break. Books that use ‘single quotes’ for speech are detected automatically.
- **Sentences** end at `.`, `!`, `?`, `…`. They don't end after common abbreviations (Mr., Dr., St.), after initials, or when a lower-case letter follows (`"Stop!" she cried.`).
- **Point of view** counts first/second/third person pronouns in *narration only*; speech and italic runs of three or more words (usually direct thought) are skipped. **Tense** compares was/were/had/did with is/are/am/has/does. A chapter is flagged when it differs from the book's usual person or tense. **Head-hopping** flags a scene (third person only) where two named characters each have two or more "thought / felt / knew / wondered…" verbs.
- **Characters** are capitalised words that are seldom seen in lower case. "Mara Voss" is merged with "Mara" and "Voss" when the full name appears twice or more.
- **Passive voice** is a form of "to be" plus a past participle; stative words ("was tired", "was scared") are excluded.

These are heuristics. Expect some false positives (a place name shown as a character, a deliberate passive) and misses; the report says so at the top.

## Rules of thumb used for "worth a look"

Average sentence over 22 words or under 9; reading level above grade 10; more than 12 adverbs per 1,000 words; more than 15% passive sentences; filler words above 25 per 1,000 words; filter words above 25 per 1,000; fewer than half of dialogue tags plain "said/asked"; chapters whose person or tense differs from the book's. They are guides for fiction, not rules.

## Where the code lives

`src/shared/analysis/`: `text.ts` (parsing, sentences, dialogue), `lexicon.ts` (word lists), `analyze.ts` (the measures), `report.ts` (the Markdown report), `embed.ts` (the stored results), `html.ts` (the formatted page, shared by the in-app view and the saved HTML/PDF; no scripts, inline SVG). `src/renderer/ReportView.tsx` shows it; `report:save` in `electron/main.ts` writes the HTML or PDF. `Workspace.analyzeFile` (in `src/renderer/workspace.ts`) runs it and opens the result in the background. The analysis yields to the UI between chapters, so it needs no worker thread and works the same on Windows and Android.
