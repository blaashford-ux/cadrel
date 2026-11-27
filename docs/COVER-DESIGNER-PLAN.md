# Cover Designer, implementation plan

Status: **planned, not started** (27 November 2026). Planned against 0.22.0. Decisions marked *decided* were taken with the owner on 27 November 2026; the rest are recommendations to confirm before the slice that needs them.

This sits beside the milestones, ahead of M7. It adds to M5's Art page and changes no record that M5 or M6 read.

## What it is

A narrow design tool for book covers: the same capabilities as a graphics suite, within a small scope, so a cover can be designed without learning Photoshop's controls. It lives under **Art**, behind a **Create asset** button that opens a drop-down. For now the drop-down holds one entry, **Cover**, with two sub-entries:

- **eBook**: freeform canvas (proportions of a Kindle cover, 1:1.6; the default is 1,600 × 2,560 px, KDP's recommended size).
- **Paperback**: the same freeform canvas with a **KDP paperback template** imported and laid over it as a **non-interactive, low-opacity overlay** (it cannot be selected, moved or exported; it shows where the spine, bleed and safe zones are).

The drop-down is built as a list of entries with sub-entries, so more kinds (banner, ad, social image) are added as data later, not as new UI.

## Principles

- **Smart, not numeric.** Nobody types a coordinate. Things snap to guides and to each other, and sizes are proportions of the canvas. Numbers can be read out, never required.
- **A few controls that do a lot.** Each effect is one switch with one or two sliders and a sensible default. "Darken behind text" is one button, not a layer-mask recipe.
- **The design is a file, the cover is an asset.** Saving keeps the editable design **and** a flattened image (*decided*). The image is the vault file that M5 governs (approval of an exact version, licence, Preflight, Launch); the design file is its source.
- **Nothing replaces anything automatically.** Saving makes a new version. Approval stays with people who may approve, as in M5.

## Where it fits

| Piece | Where | Used for |
|---|---|---|
| Art page, Assets and Briefs tabs, the open-asset view | `shell/src/renderer/Art.tsx`, `main/art.ts` | the **Create asset** button goes on the Assets tab; a saved cover appears as an asset and can carry a licence, approvals and uses as any asset does |
| Vault files with exact versions and hashes; file kinds `image`, `asset` | `kernel/vault.ts`, `kinds.ts` | the flattened image and the design file are both vault files; the design file is linked to the image through `fileLinks` ("made from") |
| Concepts offered against a brief | M5 `concept` records | a design can be offered as a concept for a cover brief from inside the designer |
| Cover rules (size, colour, resolution) | `kernel/preflightRules.ts`, `epubInspect.ts` | the designer shows the same limits live (too small, wrong ratio) so a cover is not first told it is wrong at Preflight |
| `sharp` (already a dependency), the PNG writer and PSD composite reader | `shell/main/*` | decoding imported images, resizing, checking the exported file; PDF pages for the template through `pdfjs-dist` (already a dependency) |
| Offline for the Art page | not built in M5 | the designer works on files already in the vault folder; saving needs the connection, as the Art page does today |

**No new capability.** Opening and editing a design needs `asset.write` on the book; creating a first version of an asset needs what "Add as an asset" needs today.

## Design

### The design file

A design is one JSON document (`*.cadrel-cover.json`, kind `asset`, area `Art\`), versioned by the vault like any file. It holds:

- the **canvas** (kind `ebook` or `paperback`, pixel size, and for paperback the template reference and its measured page size);
- an ordered list of **layers**, each with a stable id, a name, locked/hidden flags, a **frame as fractions of the canvas** (x, y, width, height, rotation), and a type:
  - `image` (an imported file by vault path and hash, crop and fit, flip);
  - `text` (the words, font, size as a fraction of canvas height, weight, case, tracking, line spacing, alignment, fill colour or gradient);
  - `shape` (rectangle, ellipse, line, ring, or a library symbol; fill is solid or gradient; corner rounding);
  - `scrim` (a darkening gradient placed behind text, see below).
- **effects** on any layer, each optional and each with few parameters: glow, drop shadow, outline, blur, opacity, blend mode (normal, multiply, screen, overlay, soft light), texture.
- **guides** the person has placed.

Imported images are **referenced by vault path and hash, not embedded**, so a design stays small, the file's licence stays on its own asset, and replacing an image is the M5 replacement proposal it already is. The design records each image's hash; opening a design whose image has changed says so and offers the new version.

### Smart layout (snaps and proportions)

All of this is pure logic over the document, so it is unit-tested without a screen.

- **Snaps** while dragging or resizing, shown as thin guide lines: canvas edges and centres; **thirds**; the golden-ratio lines; a **safe margin** (the title-safe inset); other layers' edges and centres; equal gaps between three or more layers. A held key turns snapping off.
- **Proportions**: resize keeps the aspect ratio by default (images, symbols), text scales by its size rather than its box; sizes snap to a short **scale set** (for a title: 8, 12, 18, 26 % of cover height) so type has a scale and not a number.
- **Arrange** buttons: align left/centre/right/top/middle/bottom to canvas or to the selection; distribute evenly; stack (centre a title block with a byline under it at a consistent gap); match width or size of two layers.
- **Title-block presets**: a handful of ready arrangements (title high / centred / low, byline and series line underneath, author name at the foot) that place real text layers using the book's catalogue fields (title, subtitle, series, author, pen name) where it can read them, which the person then edits.
- **Safe zones** (toggle): the outer margin retailers may crop and the area a small thumbnail keeps legible. A **thumbnail strip** shows the cover at 160, 80 and 40 px wide so type that dies at thumbnail size is seen while designing.
- Undo and redo for every change; copy, paste, duplicate, group of one level (so a title block moves as one).

### Enhancements

Each is a panel with a toggle and defaults chosen to look right on a first click.

- **Glow** (colour, size, strength), **drop shadow** (colour, distance and angle by a small dial, blur, opacity), **outline** (colour, width), **blur**, **opacity**.
- **Darken behind text**: with a text layer selected, one button adds a `scrim` layer behind it, sized to the text with padding, as a soft-edged gradient (top to bottom, bottom to top, or all round) from a dark colour at a chosen strength to transparent. It follows the text if the text moves (the scrim is bound to it) until the person detaches it.
- **Colour grade** on an image: brightness, contrast, saturation, warmth, and a **tint** (a flat colour over the image at a strength). Vignette.
- **Solid and gradient shapes**: linear, radial and angular gradients with two to four stops; swatches pulled from the cover's own dominant colours so the palette matches the picture.
- **Texture** on shapes and text: a small built-in set (paper grain, film grain, brushed metal, foil, stone, cloth, distress/scratches) applied as a masked overlay at a strength and scale, so type can look foil-stamped or worn. Built-in textures are generated by code (noise), not downloaded, so there is nothing to license.
- **Library of simple assets**: dividers and flourishes, stars, rule lines, frames and borders, ornaments, badges and plain-shape symbols (swords, crowns, hearts, moons, leaves, keys, a series-number badge). Built as vector paths we draw ourselves, recolourable, so there is no third-party licence to track. The person's own imported SVG or PNG can be added to a book's library.
- **Type**: plain text only (no rich text boxes). Fonts are **the fonts installed on the computer plus a short bundled starter set** under open licences (*decided*); the starter set also carries **ready pairings** (title + byline) so there is no hunting through hundreds. The licence of every bundled font is recorded in `docs/PROVENANCE.md`. The design records the fonts it used; opening a design on a computer without one says which is missing and shows the nearest stand-in rather than failing.

### The KDP paperback template

- **Import** a template as PNG or JPG, or **PDF** (KDP's cover template generator produces both): a PDF page is rendered to an image with `pdfjs-dist`. The page size is read from the file where it is present and the design canvas takes that size (trim size, spine and bleed come from it; Cadrel does not calculate them).
- The template is stored beside the design as a vault file and **referenced by path and hash**; it is drawn **above everything, at low opacity (a slider, default 35 %), ignoring clicks**, can be hidden by a button, and is **never part of the exported image**.
- The canvas has three **regions read from the template's proportions** only if the person marks them: front cover, spine, back cover (three drag handles on the overlay, snapped to the template's lines). Once marked, guides appear on those edges and the snaps use them, so a spine title centres on the spine.
- The export for a paperback is the **full wrap** as one image (back + spine + front), and a second **front cover only** crop for the ebook and listings, from the front region the person marked.
- Not built: calculating a template from trim size, page count and paper (*decided*: import only).

### Saving and export

- **Save** writes a new version of the design file and **re-renders the flattened image** as a new version of the cover's asset file (PNG by default; JPEG at a chosen quality for a size limit). Both are checked in together, so the image is always the render of that exact design version, and the design file records the image's hash.
- **Export** is rendered in the app from the same drawing the person is looking at (what you see is what is exported), at the canvas pixel size. The rendered file is read back with `sharp` to check its pixel size and format before it is saved.
- A new asset starts as a **draft**; it goes through M5's approval as usual. **Offer as a concept** is available from the designer for a book with a cover brief.
- **Reopen** from the asset's page ("Edit design") when the asset has a design file; an asset with only a flattened image can be opened as an image layer in a new design.

### Where the code lives

- A new package-free module in the shell, kept apart from `Art.tsx`: `shell/src/renderer/cover/` (the editor: canvas view, layer list, property panel, library, template overlay), `shell/src/shared/cover/` (the document model, snapping, effects as pure functions, font pairings, library paths), `shell/src/main/coverDesign.ts` (open, save, export check, template import, installed fonts). Pure logic lives in `shared` so it is tested without Electron.
- The drawing is **SVG in the renderer** (filters give glow, shadow, blur; gradients and patterns are native; hit-testing is the DOM's). Export draws the same SVG onto a canvas and reads out a PNG. This avoids two renderers that can disagree.

## Slices

Each ends with its tests passing and the page usable. They are built on `dev` in this order, and a release can be cut after slice 4 or 6.

1. **Document, canvas and the drop-down.** The design document and its validation; the canvas at the right size; the **Create asset ▾ → Cover → eBook / Paperback** drop-down on the Assets tab; creating, saving and reopening an empty design; the flattened image and the design saved as two linked vault files; the new cover appears as a draft asset. *Includes the export spike*: render a text layer with a shadow and a gradient shape to a PNG in the Electron renderer and read it back, to prove what-you-see-is-exported before anything else is built on it.
2. **Layers and the basics.** Import images (from the vault, or from disk into the vault), add text, shapes and solid and gradient fills; select, move, resize, rotate, reorder, hide, lock; undo and redo; fonts (installed and the starter set).
3. **Smart layout.** Snaps and guides, the scale set, align, distribute and stack, safe zones, the thumbnail strip, title-block presets read from the catalogue.
4. **Enhancements.** Glow, shadow, outline, blur, opacity, blend modes; darken behind text; colour grade and tint; palette from the picture; textures on shapes and text.
5. **Library.** The built-in symbols, dividers, frames and badges; a book's own imported pieces.
6. **Paperback.** Template import (PNG, JPG, PDF), the non-interactive overlay with opacity and hide, marking the front, spine and back, the full-wrap export and the front-only crop.
7. **Joining the rest.** Live size and ratio warnings from the cover rules, Offer as a concept, Edit design from the asset page, the assistant able to read a design's layers (not to change one), the changelog, the plan and an exit test.

## Exit test

**Exit:** from a book with a cover brief, a person makes an eBook cover from an imported picture, a title and a byline with the title block preset, a darkened band behind the title, a glow and a foil texture on it, one divider from the library; sees it fit the safe zone and read at thumbnail size; saves it and reopens it later to change the title colour; offers it as a concept, chooses it, and approves its version; and Preflight's cover check reads that same file. Then the same person makes a paperback cover with a KDP template laid over it, marks the spine, centres a spine title on it, and exports a full wrap and a front crop, with no trace of the template in either image.

Automated: the document and snapping (many generated layouts against stated invariants: a snapped edge is within the threshold, equal gaps are equal, a scrim stays bound to its text), the design round trip (save, reopen, the same document), the export check (the image's size and format are what the design says and the template is not in it), the Create-asset drop-down and the editor drawn and clicked in jsdom. The exit walkthrough on a real Windows build is manual and has no recorded run.

## Risks and open points

- **Export fidelity.** SVG filters, text with an installed font and gradients can draw slightly differently from one machine to another. Slice 1's spike and a golden-image check against a small fixed design decide whether this is acceptable before more is built on it.
- **Fonts on another computer or on a phone.** A design that uses an installed font does not carry it. The flattened image is what is approved and published, so a cover cannot change under a listing; the risk is only to later *editing* on a different computer, which is why the missing-font message and the starter set exist. Embedding a font file in a design is left out because of font licences.
- **PDF templates.** KDP's PDF template may carry its guides as vector lines and text; rendering a page to an image keeps them. A template with several pages is not supported (the first page is used and the person is told).
- **Size.** This is a large feature, comparable to M5. The slices are ordered so something useful (slices 1 to 3: a freeform canvas with snapping) exists early.
- **Not in this plan:** a general image editor (retouching, selections, brushes), rich text, layer masks drawn by hand, print-ready PDF with embedded CMYK profiles, Android, offline saving, a shared template library, AI image generation, and kinds other than Cover in the drop-down. Each can be added without changing what is here.

## Decisions taken (27 November 2026)

1. **Saved output:** the editable design and a flattened image, both as vault files; the image is the governed asset.
2. **Fonts:** installed fonts plus a curated, openly licensed starter set with ready pairings.
3. **Paperback template:** PNG, JPG and PDF import only; Cadrel does not calculate spine width or bleed.
