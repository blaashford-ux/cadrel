import { useMemo } from 'react';
import { buildFrontMatter, safeUrl } from '../shared/export/matter';
import type { BookDetails } from '../shared/export/model';
import { Field, ListEditor, TextArea, Toggle } from './formParts';

const urlHint = (url: string) =>
  url.trim() && !safeUrl(url) ? <span className="bad">Only http(s) and mailto links are used — this one will be left out.</span> : null;

export interface BookFormProps {
  details: BookDetails;
  set(patch: Partial<BookDetails>): void;
  /** Editing the defaults for new books: no title / subtitle, and the year may be left blank (= the current year). */
  template?: boolean;
}

function helpers({ details, set }: BookFormProps) {
  const setCopyright = (patch: Partial<BookDetails['copyright']>) => set({ copyright: { ...details.copyright, ...patch } });
  const setBack = <K extends keyof BookDetails['back']>(k: K, patch: Partial<BookDetails['back'][K]>) =>
    set({ back: { ...details.back, [k]: { ...details.back[k], ...patch } } });
  return { setCopyright, setBack, c: details.copyright };
}

export function TitleCopyrightForm(props: BookFormProps) {
  const { details, set, template } = props;
  const { setCopyright, c } = helpers(props);
  const preview = useMemo(() => (details ? buildFrontMatter(details).find((p) => p.id === 'copyright') : undefined), [details]);
  return (
    <>
              <section>
                <h4>{template ? 'Author' : 'Title page'}</h4>
                {template ? (
                  <p className="muted small">New books start with this author name. The title is taken from each file’s name until you change it.</p>
                ) : (
                  <p className="muted small">Entered exactly as you type them — nothing is split, re-cased or guessed.</p>
                )}
                {!template && <Field label="Title" required value={details.title} onChange={(v) => set({ title: v })} />}
                {!template && (
                  <Field label="Subtitle" value={details.subtitle} onChange={(v) => set({ subtitle: v })} hint="Optional. Shown in italics under the title." />
                )}
                <Field label="Author / pen name" required={!template} value={details.author} path="author" onChange={(v) => set({ author: v })} />
              </section>
              <section>
                <h4>Copyright page</h4>
                <div className="row2">
                  <Field label="Copyright year" value={c.year} width={140} placeholder={template ? String(new Date().getFullYear()) : undefined} path="copyright.year" onChange={(v) => setCopyright({ year: v })} hint={template ? 'Leave blank to use the current year.' : undefined} />
                  <Field label="Edition line" value={c.edition} path="copyright.edition" onChange={(v) => setCopyright({ edition: v })} hint="Leave blank to omit." />
                </div>
                <div className="row2">
                  <Field label="Publisher" value={c.publisher} path="copyright.publisher" onChange={(v) => setCopyright({ publisher: v })} hint="Optional." />
                  <Field label="ISBN" value={c.isbn} path="copyright.isbn" onChange={(v) => setCopyright({ isbn: v })} hint="Optional." />
                </div>
                <Toggle label="Fiction disclaimer" checked={c.fictionDisclaimer} path="copyright.fictionDisclaimer" onChange={(v) => setCopyright({ fictionDisclaimer: v })} />
                {c.fictionDisclaimer && <TextArea label="Wording" rows={3} value={c.fictionText} path="copyright.fictionText" onChange={(v) => setCopyright({ fictionText: v })} />}
                <TextArea label="Reproduction-rights paragraph" rows={3} value={c.reproductionText} path="copyright.reproductionText" onChange={(v) => setCopyright({ reproductionText: v })} hint="Leave blank to omit." />
                <Toggle label="Mature-content notice (18+)" checked={c.matureNotice} path="copyright.matureNotice" onChange={(v) => setCopyright({ matureNotice: v })} />
                {c.matureNotice && <TextArea label="Wording" rows={2} value={c.matureText} path="copyright.matureText" onChange={(v) => setCopyright({ matureText: v })} />}
                <Toggle label="Content Warning" checked={c.contentWarning} path="copyright.contentWarning" onChange={(v) => setCopyright({ contentWarning: v })} />
                {c.contentWarning && <TextArea label="Wording" rows={2} value={c.contentWarningText} path="copyright.contentWarningText" onChange={(v) => setCopyright({ contentWarningText: v })} />}
                <h5>Extra lines</h5>
                <ListEditor
                  items={c.extraLines}
                  path="copyright.extraLines" onChange={(extraLines) => setCopyright({ extraLines })}
                  blank={() => ''}
                  addLabel="Add a line"
                  row={(line, update) => <input aria-label="Extra line" value={line} onChange={(e) => update(e.target.value)} />}
                />
                <div className="preview-box" aria-label="Copyright page preview">
                  <div className="preview-title">Copyright page preview</div>
                  {preview?.blocks.map((b, i) => (
                    <p key={i} className={b.t === 'para' && b.bold ? 'bold' : ''}>
                      {'text' in b ? b.text : ''}
                    </p>
                  ))}
                </div>
              </section>
    </>
  );
}

export function FrontMatterForm(props: BookFormProps) {
  const { details, set } = props;
  return (
    <>
              <section>
                <h4>Dedication</h4>
                <Toggle label="Include a dedication page" checked={details.dedication.enabled} path="dedication.enabled" onChange={(v) => set({ dedication: { ...details.dedication, enabled: v } })} />
                {details.dedication.enabled && (
                  <TextArea label="Text" value={details.dedication.text} path="dedication.text" onChange={(v) => set({ dedication: { ...details.dedication, text: v } })} hint="Blank lines start a new paragraph." />
                )}
              </section>
              <section>
                <h4>Epigraph</h4>
                <Toggle label="Include an epigraph page" checked={details.epigraph.enabled} path="epigraph.enabled" onChange={(v) => set({ epigraph: { ...details.epigraph, enabled: v } })} />
                {details.epigraph.enabled && (
                  <>
                    <TextArea label="Quotation" value={details.epigraph.text} path="epigraph.text" onChange={(v) => set({ epigraph: { ...details.epigraph, text: v } })} />
                    <Field label="Attribution" value={details.epigraph.attribution} path="epigraph.attribution" onChange={(v) => set({ epigraph: { ...details.epigraph, attribution: v } })} hint="Shown as “— Name”." />
                  </>
                )}
              </section>
    </>
  );
}

export function BackMatterForm(props: BookFormProps) {
  const { details } = props;
  const { setBack } = helpers(props);
  return (
    <>
              <p className="muted small">Each page starts on its own page after the last chapter. No link is ever added unless you type it here.</p>
              <section>
                <h4>Continue the story</h4>
                <Toggle label="Include this page" checked={details.back.links.enabled} path="back.links.enabled" onChange={(v) => setBack('links', { enabled: v })} />
                {details.back.links.enabled && (
                  <>
                    <Field label="Heading" value={details.back.links.heading} path="back.links.heading" onChange={(v) => setBack('links', { heading: v })} />
                    <TextArea label="Text" rows={3} value={details.back.links.intro} path="back.links.intro" onChange={(v) => setBack('links', { intro: v })} />
                    <ListEditor
                      items={details.back.links.items}
                      path="back.links.items" onChange={(items) => setBack('links', { items })}
                      blank={() => ({ label: '', url: '' })}
                      addLabel="Add a link"
                      row={(it, update) => (
                        <>
                          <input aria-label="Link label" placeholder="Label (e.g. Join my mailing list)" value={it.label} onChange={(e) => update({ ...it, label: e.target.value })} />
                          <input aria-label="Link address" placeholder="https://…" value={it.url} onChange={(e) => update({ ...it, url: e.target.value })} />
                          {urlHint(it.url)}
                        </>
                      )}
                    />
                  </>
                )}
              </section>
              <section>
                <h4>Also by the author</h4>
                <Toggle label="Include this page" checked={details.back.alsoBy.enabled} path="back.alsoBy.enabled" onChange={(v) => setBack('alsoBy', { enabled: v })} />
                {details.back.alsoBy.enabled && (
                  <>
                    <Field label="Heading" value={details.back.alsoBy.heading} placeholder={`ALSO BY ${details.author.toUpperCase() || 'AUTHOR'}`} path="back.alsoBy.heading" onChange={(v) => setBack('alsoBy', { heading: v })} hint="Leave blank for the default shown." />
                    <ListEditor
                      items={details.back.alsoBy.items}
                      path="back.alsoBy.items" onChange={(items) => setBack('alsoBy', { items })}
                      blank={() => ({ title: '', url: '', blurb: '' })}
                      addLabel="Add a book"
                      row={(it, update) => (
                        <>
                          <input aria-label="Book title" placeholder="Book title" value={it.title} onChange={(e) => update({ ...it, title: e.target.value })} />
                          <input aria-label="Book link" placeholder="https://… (optional)" value={it.url} onChange={(e) => update({ ...it, url: e.target.value })} />
                          {urlHint(it.url)}
                          <textarea aria-label="Book blurb" placeholder="Blurb (optional)" rows={4} value={it.blurb} onChange={(e) => update({ ...it, blurb: e.target.value })} />
                        </>
                      )}
                    />
                  </>
                )}
              </section>
              <section>
                <h4>About the author</h4>
                <Toggle label="Include this page" checked={details.back.about.enabled} path="back.about.enabled" onChange={(v) => setBack('about', { enabled: v })} />
                {details.back.about.enabled && (
                  <>
                    <Field label="Heading" value={details.back.about.heading} path="back.about.heading" onChange={(v) => setBack('about', { heading: v })} />
                    <TextArea label="Bio" value={details.back.about.text} path="back.about.text" onChange={(v) => setBack('about', { text: v })} />
                  </>
                )}
              </section>
              <section>
                <h4>Custom page</h4>
                <Toggle label="Include this page" checked={details.back.custom.enabled} path="back.custom.enabled" onChange={(v) => setBack('custom', { enabled: v })} />
                {details.back.custom.enabled && (
                  <>
                    <Field label="Heading" value={details.back.custom.heading} path="back.custom.heading" onChange={(v) => setBack('custom', { heading: v })} hint="Optional. A heading also adds the page to the contents." />
                    <TextArea label="Text" value={details.back.custom.text} path="back.custom.text" onChange={(v) => setBack('custom', { text: v })} />
                  </>
                )}
              </section>
    </>
  );
}
