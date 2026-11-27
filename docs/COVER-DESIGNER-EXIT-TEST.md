# Cover Designer exit test: a manual walk-through on Windows

The exit in [COVER-DESIGNER-PLAN.md](COVER-DESIGNER-PLAN.md): from a book with a cover brief, a person makes an eBook cover from an imported picture, a title and a byline with the title block preset, a darkened band behind the title, a glow and a foil texture on it, and one divider from the library; sees it fit the safe margin and read at thumbnail size; saves it and reopens it later to change the title colour; offers it as a concept, chooses it, and approves its version; and Preflight's cover check reads that same file. Then the same person makes a paperback cover with a KDP template laid over it, marks the spine, centres a spine title on it, and exports a full wrap and a front crop, with no trace of the template in either.

The automated half is `packages/shell/test/coverExit.test.ts` (the chain from a brief to Preflight, over a real vault), `coverDesigner.test.tsx` (the screen), and `coverExport.test.ts` (the picture, drawn in a real browser). This walk-through covers what they cannot: the packaged app on Windows, the real file pickers, and whether it feels easy.

Use a real book in a Studio you can afford to leave a few draft files in. Write down anything that surprised you.

## An eBook cover

1. On **Art**, choose **Create asset ▾ → Cover → eBook**. The designer opens on an empty 1,600 × 2,560 cover. *Expect:* the menu closes by itself; nothing is saved yet.
2. **Add a picture from your computer** (a PNG or JPEG of at least 1,600 pixels). *Expect:* it fills the cover, cropped to fit; it is listed under Layers; it is now also a file in the project (check on **Files**, under `Art\<project>\Pictures`).
3. On the picture, try **Slide across**, **Zoom**, **Brightness** and **Dark edges**. *Expect:* each moves the picture at once; nothing asks for a number.
4. **Title block**: fill the title, a line under it, the series and your name; choose **Title low** and a font pairing; **Lay out the title block**. *Expect:* four text layers, in the pairing's fonts, inside the cover, not touching each other. Do it again with another pairing: it replaces the block.
5. Select the title. **Darken behind this text.** *Expect:* a soft dark band behind it. Drag the title: the band follows. Choose **Let it go** on the band, drag the title again: the band stays.
6. On the title, switch on **Glow**, then **Texture → Foil**. Try each of the other textures. *Expect:* the words look stamped; Worn and scratched takes paint away in patches.
7. **Library → Dividers → Rule with a diamond**; drag it under the title. *Expect:* lines appear when it is on the middle, the margin or another layer, and it jumps to them; hold **Alt** to move it freely.
8. Look at the **thumbnails** beside the cover (160, 80 and 40 pixels). Can you still read the title at 80 and 40? Turn on **Safe margin**: is everything inside the dashed line?
9. **Undo** five times, **Redo** five times. One drag is one step.
10. Name it and **Save**. *Expect:* "Saved as version 1 … waiting for someone to approve it". On **Files**: `Art\<project>\<name>.cadrel-cover.json` and `<name>.png`. On **Art → Assets**: the cover, in Draft.

## Changing it later

11. Close the designer, come back another day, **Edit design** on the cover. *Expect:* it opens as you left it. Change the title colour with a swatch from the picture and **Save**. *Expect:* version 2 of both files.
12. In **Files**, replace the picture you used with another version and open the design again. *Expect:* a note that the picture has a newer version than the one the design was saved with.

## Brief, concept, approval, Preflight

13. On **Art → Briefs**, open the cover brief and **offer the saved picture as a concept**, then **Choose this concept**. *Expect:* the cover is **In review**.
14. As someone who may approve, **approve version 2** on the cover. *Expect:* version 2 is approved; a later save is **a newer version that is not approved**.
15. Export an EPUB with that picture as its cover and run **Preflight** on it. *Expect:* no "not the approved cover" warning, and no cover size error. Put a different cover in the EPUB: the warning appears.

## A paperback

16. **Create asset → Cover → Paperback.** On the **Wrap** tab, **Import the KDP template** (the PDF KDP gave you). *Expect:* the cover takes its size; the template shows faintly over it, and you cannot click it.
17. **Template strength**, **Hide template**, **Show template**. *Expect:* the template comes and goes; neither the stage nor Layers lists it.
18. **Mark the spine**: drag the two lines to the edges of the spine on the template. *Expect:* guides appear there.
19. Add a text layer for the spine title, select it, **Centre the selected layer on the spine**. *Expect:* it sits in the middle of the spine.
20. Lay out the front: a title and a picture on the front panel. **Save.** *Expect:* on **Files**, `<name>.png` (the full wrap) and `<name>-front.png` (the front only). Open both: **neither shows any trace of the template.**

## Record

Date, version, computer, who did it, anything that surprised you or that you had to ask someone: ______
