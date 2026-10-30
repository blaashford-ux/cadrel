---
name: cadrel-outline-to-keywords
description: "Generates the seven Amazon KDP backend keyword fields (50 characters each) for a book from its story bible or outline, targeting HaremLit, Men's Adventure and adjacent progression-fantasy and LitRPG markets by default and adaptable to other genres, validates them against KDP's rules with the check_keywords tool, and saves them as Marketing/Keywords.md. Use when the user wants KDP backend keywords, Amazon search-term optimization, or keywords for a book that has an outline or story bible, and the Cadrel project tools are available. Invisible backend metadata only, never anything a shopper sees."
---

# Outline to Keywords (Cadrel)

Produces seven distinct, non-overlapping keyword phrases for KDP's backend keyword fields, derived from the project's story bible or outline. They are invisible metadata that Amazon's search stack uses to match reader queries, never shown to shoppers, so there is no narrative-quality bar here, only search relevance and the platform's hard technical limits.

## Working in Cadrel

You have Cadrel's project tools. A project is a folder of Markdown files.

1. **Find the project.** `list_projects`; if it isn't clear which one, ask.
2. **See what exists before you create anything.** `list_project_files` shows every file with its kind (premise, outline, character, world, ...). `read_project_file` reads one; a long file comes in parts, so pass `start` to continue.
3. **Save what you make.** `write_project_file` creates a file. It never touches the manuscript, never replaces an existing file unless you pass `mode: "replace"` (the previous version is kept), and can't leave the project folder.
4. **Check the rules with the tool, not by eye.** `check_keywords` takes the seven phrases and the book's title, subtitle and categories, and reports every violation (length, punctuation, repeated words, title overlap, banned terms, off-market terms). Run it on the final set, and again after every change.

If the tools aren't available, do the same checks by hand and show your word-by-word check in the reply.

## Step 1: Extract key features from the story bible

Pull from the outline or bible: subgenres (Monster Girl, Magic Academy, LitRPG, Progression Fantasy, Cultivation, Dungeon Crawl, Urban Fantasy), core hooks (creature types, protagonist role, unique setting elements: dragon girl, succubus, demon queen, dungeon lord, class crafting), fantasy activities (dungeon crawling, base-building, kingdom-building, monster-taming, summoning), and genre and tone labels (harem fantasy, men's adventure, litrpg, gamelit).

## Step 2: Get the title, subtitle and categories

**This is required, not optional.** A keyword phrase must never repeat a word already in the book's title, subtitle or chosen browse categories, since Amazon indexes those separately and a repeated word wastes backend space. Ask for the finished or working title, subtitle and any categories already selected before generating candidates. If categories aren't chosen yet, proceed without that constraint and flag that it is worth re-checking once they are.

## Step 3: Generate candidate phrases

Combine the Step 1 features into 2 to 5 word phrases a real reader would type or speak: specific and multi-concept, not generic single words (a single-word slot indexes far too broadly). Patterns worth generating from:

- `[Hook] + [Subgenre] + [Genre]`: "monster girl academy fantasy"
- `[Activity] + [Subgenre]`: "dungeon crawl fantasy"
- `[Subgenre] + [Genre]`: "progression fantasy adventure"
- `[Hook] + [Activity]`: "dragon rider adventure"
- Adjacent-market phrases where genuinely relevant: "litrpg", "gamelit", "isekai", "cultivation"

Generate more than you need, 15 to 20; pruning works much better from a real pool than from exactly seven first attempts. See the **Keyword bank** below for recurring phrases in this niche.

## Step 4: Score and rank

Score each candidate on five factors. This is qualitative genre-knowledge scoring, not Amazon search-volume data (say so if asked; you have no access to real query volume):

- **Genre match (35%):** how closely it matches this book's actual subgenre and market.
- **Bestseller frequency (25%):** how often the phrase or its concept shows up in top-performing titles in this niche. Use web search on current bestseller lists if you have it and are unsure; the niche's conventions shift.
- **Buyer intent (20%):** how naturally it reads as something a reader would search, rather than author-internal phrasing.
- **Hook specificity (15%):** a real differentiating element (a specific creature, ability or setting) rather than a generic genre label alone.
- **Competition penalty (-15%):** very generic, heavily used terms ("harem", "fantasy" alone) are docked in favor of specific combinations.

`Score = 0.35 x Genre + 0.25 x Frequency + 0.20 x Intent + 0.15 x Specificity - 0.15 x Competition`

Sort high to low. Treat the order as a strong starting point; Step 5's hard constraints will eliminate some high scorers.

## Step 5: Prune, with hard uniqueness rules

Be strict here.

- **No word may appear more than once across all seven slots.** Not "no repeated root": no repeated word, full stop. Amazon combines the seven fields into one index, so a word in slot 1 does nothing for you when reused in slot 4.
- **No word from the title, subtitle or chosen categories** may appear in any slot.
- Drop single-word candidates entirely.
- If two candidates share a core concept ("academy fantasy" and "magic academy fantasy"), keep the higher scorer.

## Step 6: Hard technical and content rules

- **50 characters per slot, spaces included.** No commas, no quotation marks; separate words with spaces only. Punctuation wastes budget and gains nothing.
- Amazon measures some content in bytes. Plain ASCII is one byte per character, so this matters only if a phrase has accented or non-standard characters; flag it if so.
- No banned, quality-claim or time-sensitive terms ("bestseller", "free", "new", "award-winning" and the like); they break KDP's own keyword rules.
- **For HaremLit and Men's Adventure positioning (the default target market):** don't use female-targeted romance or opposite-market terms ("reverse harem", "why choose", "poly romance", "strong heroine"). They don't match this book's buyer and waste a slot. If the project isn't male-targeted HaremLit, judge for yourself what is off-market for its actual genre and audience, and tell `check_keywords` to switch that check off (`male_targeted: false`).

## Step 7: Allocate the seven slots

Fill for variety, not raw score order. Each slot covers a genuinely distinct search concept:

1. The highest-scoring core genre or hook phrase.
2. The next best, featuring a different hook or creature or character type.
3. An activity or subgenre phrase (dungeon crawl, summoning, base-building).
4. A secondary genre or subgenre phrase.
5. Another hook or subgenre variant not yet covered.
6. An adjacent-market phrase (LitRPG, progression fantasy) if genuinely relevant.
7. A wildcard long-tail phrase covering any real remaining angle. Don't force a weak phrase into slot 7 to fill it; a longer, more specific phrase beats generic filler.

## Step 8: Final validation

Run `check_keywords` on the finished seven, with the title, subtitle and categories. Fix every violation it reports and run it again until it comes back clean. Then confirm yourself that the seven are seven different search concepts.

## Step 9: Save

Save `Marketing/Keywords.md` with `write_project_file`, numbered 1 to 7, each phrase on its own line with its character count so the author can verify at a glance; it is meant to be pasted straight into the KDP dashboard's seven fields. Record the title, subtitle and categories you checked against, and note anything the author should re-check (for example categories not yet chosen). If the file exists, ask before replacing it (the old version is kept).

```markdown
# KDP Backend Keywords: [Title]

Checked against: title "...", subtitle "...", categories ...

1. monster girl academy fantasy (29)
2. ...
```

---

## Keyword bank: HaremLit, Men's Adventure and adjacent markets

A starter for calibrating the genre-match and frequency scores. These are recurring concepts, not a copy-paste list: combine and adapt to the book. Exact-duplicate keyword strategy across many books is less effective, and across one author's catalog it is easy to end up violating the no-repeat rule.

**Creature and hook terms:** monster girl, succubus, demon queen, dragon girl, elf, catgirl, kitsune, lamia, gorgon, slime girl, vampire, fox girl, dungeon lord.

**Subgenre and setting terms:** magic academy, dungeon crawl, cultivation, progression fantasy, base building, kingdom building, monster taming, summoner, urban fantasy, litrpg, gamelit, isekai.

**Genre and audience labels:** harem fantasy, men's adventure, men's fantasy adventure, adventure romance.

**Example combinations (illustrative):** monster girl academy fantasy; dragon girl fantasy adventure; succubus harem adventure; dungeon crawl fantasy; summoner fantasy litrpg; progression fantasy adventure; base building harem fantasy; kitsune fantasy romance.

**The error this guards against.** A set that reuses "fantasy" across five of seven slots is not valid even if each phrase looks reasonable alone. The point of seven slots is seven different search concepts. List every word used across all seven in one place and confirm none repeats; it takes thirty seconds and catches the commonest mistake.
