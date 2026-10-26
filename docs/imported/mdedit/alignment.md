# Text alignment (0.7.1)

Body text is justified by default in the EPUB, the print PDF and the Word file. To line a part up differently (a centred poem, a right-aligned sign-off, a left-aligned letter) put it in an **alignment fence**:

```
::: center
A centred title or verse,
as many paragraphs as you like.
:::
```

`left`, `center` (or `centre`), `right` and `justify` are the four alignments. A fence can hold paragraphs, headings, quotes and lists. Fences don't nest: an opener inside a fence ends the first and starts the next.

## In the editor

- **Buttons** in the toolbar above the text (desktop) and in the bar above the keyboard (phone) set the alignment of the selected paragraphs. Pressing the one already in force removes it.
- **Keys:** Ctrl+Shift+L (left), E (centre), R (right), J (justify). (Ctrl+E on its own is Export.)
- The formatted view draws the text aligned, with a dotted rule beside it and a small label (hover) so you can see where a fence is. Source mode shows the `:::` lines as typed.

## In the file

MDEdit writes a blank line around each fence line, and reads them with or without one. Other Markdown editors show the `:::` lines as text. One rule: after a **quote or a list**, leave a blank line before the closing `:::`, or the closing line is read as part of the quote or list item.

## In the export

Alignment becomes CSS classes in the EPUB and PDF and paragraph alignment in the Word file. Centred and right-aligned paragraphs have no first-line indent. Scene breaks, chapter headings and sub-headings keep their usual look unless a fence says otherwise.

**Body text alignment** (Book Details → Export, per output: EPUB, print PDF, Word) chooses what unfenced paragraphs do: *Justified* (default) or *Left (ragged right)*. It layers like the other export settings (app → project → book).

Word counts, the progress totals and text analysis ignore the fence lines.

## Code

`src/shared/align.ts` (the syntax), `src/shared/export/manuscript.ts` (parsing into aligned blocks), `src/shared/export/html.ts`, `epub.ts`, `printHtml.ts`, `docx.ts` (output), `src/renderer/alignPlugin.ts` (the editor node, its Markdown reading and writing, and the command).
