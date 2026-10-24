import type { BodyAlign, BookDetails, ParagraphStyle } from '../shared/export/model';
import { OUTPUT_LABELS, type OutputKind } from '../shared/export/outputs';
import { TRIM_SIZES } from '../shared/export/trim';
import { FontSelect } from './FontSelect';
import { Field, NumberField, Select, TextArea, Toggle } from './formParts';

export const PSTYLE: { value: ParagraphStyle; label: string }[] = [
  { value: 'blockGap', label: 'Blank line between paragraphs' },
  { value: 'blockNoGap', label: 'No gap between paragraphs' },
  { value: 'indent', label: 'First-line indent' }
];
export const BODY_ALIGN: { value: BodyAlign; label: string }[] = [
  { value: 'justify', label: 'Justified (flush both sides)' },
  { value: 'left', label: 'Left (ragged right)' }
];
export const TRIM_OPTIONS = TRIM_SIZES.map((t) => ({ value: t.key, label: `${t.label}${t.key === '5.5x8.5' ? ' (default)' : ''}` }));
export const KINDS: OutputKind[] = ['epub', 'pdf', 'docx'];

export interface ExportFormProps {
  details: BookDetails;
  edit(fn: (d: BookDetails) => void): void;
  /** Editing the defaults for new books: no cover image (that belongs to one book). */
  template?: boolean;
}

/** The output checkboxes, each with its own variables. */
export function OutputsForm({ details, edit, template }: ExportFormProps) {
  const e = details.export;
  const toggleOutput = (k: OutputKind, on: boolean) => edit((d) => void (d.export.outputs[k] = on));
  return (
            <section>
              <h4>Outputs</h4>
              {KINDS.map((k) => (
                <div key={k} className="output-block">
                  <Toggle label={OUTPUT_LABELS[k]} path={`export.outputs.${k}`} checked={e.outputs[k]} onChange={(v) => toggleOutput(k, v)} />
                  {e.outputs[k] && k === 'epub' && (
                    <div className="output-panel">
                      <div className="row2">
                        <Field label="Language code" value={e.epub.language} width={160} path="export.epub.language" onChange={(v) => edit((d) => void (d.export.epub.language = v))} hint="e.g. en, en-GB, fr" />
                        <Select label="Paragraphs" value={e.epub.paragraphStyle} options={PSTYLE} path="export.epub.paragraphStyle" onChange={(v) => edit((d) => void (d.export.epub.paragraphStyle = v))} />
                        <Select label="Text alignment" value={e.epub.bodyAlign} options={BODY_ALIGN} path="export.epub.bodyAlign" onChange={(v) => edit((d) => void (d.export.epub.bodyAlign = v))} hint="Applies to body paragraphs. Use a ::: center fence in the text to align a part differently." />
                      </div>
                      <FontSelect
                        label="Font"
                        value={e.epub.font}
                        path="export.epub.font" onChange={(v) => edit((d) => void (d.export.epub.font = v))}
                        hint="The included fonts are embedded in the ebook so every reader shows them. A font installed on your computer is only named — e-readers use it only if they have it."
                      />
                      <TextArea label="Description" rows={3} value={e.epub.description} path="export.epub.description" onChange={(v) => edit((d) => void (d.export.epub.description = v))} hint="Stored in the ebook’s metadata (KDP uses its own listing form for the store description)." />
                      <div className="row2">
                        <Field label="Publisher" value={details.copyright.publisher} path="copyright.publisher" onChange={(v) => edit((d) => void (d.copyright.publisher = v))} hint="Also printed on the copyright page." />
                        <Field label="ISBN" value={details.copyright.isbn} path="copyright.isbn" onChange={(v) => edit((d) => void (d.copyright.isbn = v))} hint="Also printed on the copyright page." />
                      </div>
                      <div className="row2">
                        <NumberField label="Font size" unit="pt" min={8} max={20} step={0.5} value={e.epub.fontSize} path="export.epub.fontSize" onChange={(v) => edit((d) => void (d.export.epub.fontSize = v))} />
                        <Toggle label="Drop cap on the first paragraph of each chapter" checked={e.epub.dropCaps} path="export.epub.dropCaps" onChange={(v) => edit((d) => void (d.export.epub.dropCaps = v))} />
                      </div>
                      {!template && (
                      <div className="field">
                        <span className="field-label">Cover image (optional, JPEG or PNG)</span>
                        <div className="inline">
                          <button
                            type="button"
                            onClick={async () => {
                              const p = await window.mdedit.pickCoverImage();
                              if (p) edit((d) => void (d.export.epub.coverImage = p));
                            }}
                          >
                            Choose image…
                          </button>
                          {e.epub.coverImage ? (
                            <>
                              <code className="path">{e.epub.coverImage}</code>
                              <button type="button" onClick={() => edit((d) => void (d.export.epub.coverImage = ''))}>
                                Remove
                              </button>
                            </>
                          ) : (
                            <span className="muted">None (KDP takes the cover as a separate upload)</span>
                          )}
                        </div>
                      </div>
                      )}
                    </div>
                  )}
                  {e.outputs[k] && k === 'pdf' && (
                    <div className="output-panel">
                      <div className="row2">
                        <Select label="Trim size" value={e.pdf.trim} options={TRIM_OPTIONS} path="export.pdf.trim" onChange={(v) => edit((d) => void (d.export.pdf.trim = v))} hint="KDP paperback sizes, from 5 × 8 in." />
                        <Select label="Paragraphs" value={e.pdf.paragraphStyle} options={PSTYLE} path="export.pdf.paragraphStyle" onChange={(v) => edit((d) => void (d.export.pdf.paragraphStyle = v))} />
                        <Select label="Text alignment" value={e.pdf.bodyAlign} options={BODY_ALIGN} path="export.pdf.bodyAlign" onChange={(v) => edit((d) => void (d.export.pdf.bodyAlign = v))} hint="Applies to body paragraphs. Use a ::: center fence in the text to align a part differently." />
                      </div>
                      <FontSelect
                        label="Font"
                        value={e.pdf.font}
                        path="export.pdf.font" onChange={(v) => edit((d) => void (d.export.pdf.font = v))}
                        hint="Any font is embedded in the PDF. Check that your licence allows commercial printing."
                      />
                      <div className="row3">
                        <Select
                          label="Inside (gutter) margin"
                          value={e.pdf.gutter === 'auto' ? 'auto' : 'manual'}
                          options={[{ value: 'auto', label: 'Automatic (KDP table)' }, { value: 'manual', label: 'Set manually' }]}
                          path="export.pdf.gutter" onChange={(v) => edit((d) => void (d.export.pdf.gutter = v === 'auto' ? 'auto' : 0.5))}
                        />
                        {e.pdf.gutter !== 'auto' && (
                          <NumberField label="Gutter" unit="in" min={0.25} max={2} value={e.pdf.gutter} path="export.pdf.gutter" onChange={(v) => edit((d) => void (d.export.pdf.gutter = v))} hint="KDP: 0.375–0.875 by page count" />
                        )}
                        <NumberField label="Outside margin" unit="in" min={0.25} max={2} value={e.pdf.outerMargin} path="export.pdf.outerMargin" onChange={(v) => edit((d) => void (d.export.pdf.outerMargin = v))} />
                      </div>
                      <div className="row3">
                        <NumberField label="Top margin" unit="in" min={0.25} max={2} value={e.pdf.topMargin} path="export.pdf.topMargin" onChange={(v) => edit((d) => void (d.export.pdf.topMargin = v))} />
                        <NumberField label="Bottom margin" unit="in" min={0.25} max={2} value={e.pdf.bottomMargin} path="export.pdf.bottomMargin" onChange={(v) => edit((d) => void (d.export.pdf.bottomMargin = v))} />
                        <NumberField label="Font size" unit="pt" min={8} max={16} step={0.5} value={e.pdf.fontSize} path="export.pdf.fontSize" onChange={(v) => edit((d) => void (d.export.pdf.fontSize = v))} />
                      </div>
                      <div className="row3">
                        <NumberField label="Chapter drop" unit="in" min={0} max={3} step={0.05} value={e.pdf.chapterSink} path="export.pdf.chapterSink" onChange={(v) => edit((d) => void (d.export.pdf.chapterSink = v))} hint="Space above each chapter heading, below the top margin. 0 starts at the margin." />
                      </div>
                      <div className="row2">
                        <Select
                          label="Running head"
                          value={e.pdf.runningHead}
                          options={[
                            { value: 'none', label: 'None' },
                            { value: 'author', label: 'Author name on every page' },
                            { value: 'title', label: 'Book title on every page' },
                            { value: 'authorTitle', label: 'Author on left pages, title on right' }
                          ]}
                          path="export.pdf.runningHead" onChange={(v) => edit((d) => void (d.export.pdf.runningHead = v))}
                        />
                        <div>
                          <Toggle label="Chapters start on a right-hand page" checked={e.pdf.rectoStarts} path="export.pdf.rectoStarts" onChange={(v) => edit((d) => void (d.export.pdf.rectoStarts = v))} />
                          <Toggle label="Page numbers" checked={e.pdf.pageNumbers} path="export.pdf.pageNumbers" onChange={(v) => edit((d) => void (d.export.pdf.pageNumbers = v))} />
                        </div>
                      </div>
                    </div>
                  )}
                  {e.outputs[k] && k === 'docx' && (
                    <div className="output-panel">
                      <div className="row3">
                        <Select label="Page size" value={e.docx.trim} options={TRIM_OPTIONS} path="export.docx.trim" onChange={(v) => edit((d) => void (d.export.docx.trim = v))} />
                        <Select label="Paragraphs" value={e.docx.paragraphStyle} options={PSTYLE} path="export.docx.paragraphStyle" onChange={(v) => edit((d) => void (d.export.docx.paragraphStyle = v))} />
                        <Select label="Text alignment" value={e.docx.bodyAlign} options={BODY_ALIGN} path="export.docx.bodyAlign" onChange={(v) => edit((d) => void (d.export.docx.bodyAlign = v))} hint="Applies to body paragraphs. Use a ::: center fence in the text to align a part differently." />
                        <NumberField label="Font size" unit="pt" min={8} max={20} step={0.5} value={e.docx.fontSize} path="export.docx.fontSize" onChange={(v) => edit((d) => void (d.export.docx.fontSize = v))} />
                      </div>
                      <p className="muted small">The contents list is linked but has no page numbers (pages can’t be measured without Word). Blank lines use non-breaking spaces so importers keep them.</p>
                    </div>
                  )}
                </div>
              ))}
            </section>
  );
}

/** Chapter-heading style, quotes and scene-break symbol. */
export function TextForm({ details, edit }: ExportFormProps) {
  const e = details.export;
  return (
            <section>
              <h4>Text</h4>
              <div className="row2">
                <Select
                  label="Chapter headings"
                  value={e.chapterHeading}
                  options={[
                    { value: 'verbatim', label: 'Exactly as I wrote them' },
                    { value: 'numberWord', label: 'Number words (Chapter Twelve: Title)' }
                  ]}
                  path="export.chapterHeading" onChange={(v) => edit((d) => void (d.export.chapterHeading = v))}
                  hint="“Chapter 12: Title” becomes “Chapter Twelve:” plus an italic title."
                />
                <Select
                  label="Typographic (curly) quotes"
                  value={e.smartQuotes}
                  options={[
                    { value: 'auto', label: 'Automatic' },
                    { value: 'always', label: 'Always convert' },
                    { value: 'never', label: 'Never convert' }
                  ]}
                  path="export.smartQuotes" onChange={(v) => edit((d) => void (d.export.smartQuotes = v))}
                  hint="Automatic converts only if your text has straight quotes."
                />
              </div>
              <Field label="Scene-break symbol" value={e.sceneBreak} width={220} path="export.sceneBreak" onChange={(v) => edit((d) => void (d.export.sceneBreak = v))} hint="Shown centred where your file has * * * or ---" />
            </section>
  );
}
