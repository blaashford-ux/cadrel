import { useState } from 'react';
import type { BookDetails } from '../shared/export/model';
import { BackMatterForm, FrontMatterForm, TitleCopyrightForm } from './bookForms';
import { OutputsForm, TextForm } from './exportForms';
import { Field, Select, Toggle } from './formParts';

type Tab = 'chapters' | 'title' | 'front' | 'back' | 'export';

export interface DefaultsValue {
  /** null = use the app's setting. */
  chapterLevel: number | null;
  /** null = use the app's defaults. */
  book: BookDetails | null;
}

interface Props {
  value: DefaultsValue;
  /** What "use the app's" resolves to, shown to the user and copied when they switch to their own. */
  app: { chapterLevel: number; book: BookDetails };
  /** "this project" / "this template", for wording. */
  scope: string;
  onChange(value: DefaultsValue): void;
}

const LEVELS = [1, 2, 3, 4, 5, 6].map((n) => ({ value: n, label: `Heading ${n}  (${'#'.repeat(n)} Title)` }));

/** Chapter heading level and book defaults, each either inherited from the app or set here (projects and templates). */
export function DefaultsEditor({ value, app, scope, onChange }: Props) {
  const [tab, setTab] = useState<Tab>('chapters');
  const book = value.book;
  const setBook = (patch: Partial<BookDetails>) => book && onChange({ ...value, book: { ...book, ...patch } });
  const editBook = (fn: (d: BookDetails) => void) => {
    if (!book) return;
    const next = structuredClone(book);
    fn(next);
    onChange({ ...value, book: next });
  };

  return (
    <div className="defaults-editor">
      <div className="subtabs" role="tablist">
        {(
          [
            ['chapters', 'Chapters'],
            ['title', 'Title & copyright'],
            ['front', 'Front matter'],
            ['back', 'Back matter'],
            ['export', 'Export']
          ] as const
        ).map(([k, label]) => (
          <button key={k} type="button" role="tab" aria-selected={tab === k} className={tab === k ? 'active' : ''} onClick={() => setTab(k)}>
            {label}
          </button>
        ))}
      </div>

      {tab === 'chapters' && (
        <section>
          <h4>Chapter headings</h4>
          <Toggle
            label={`Use the app setting (Heading ${app.chapterLevel})`}
            checked={value.chapterLevel === null}
            onChange={(on) => onChange({ ...value, chapterLevel: on ? null : app.chapterLevel })}
          />
          {value.chapterLevel !== null && (
            <Select<number>
              label={`A chapter in ${scope} starts at`}
              value={value.chapterLevel}
              options={LEVELS}
              onChange={(v) => onChange({ ...value, chapterLevel: v })}
              hint="Used for the editor and for exports from this level of the app."
            />
          )}
        </section>
      )}

      {tab !== 'chapters' && (
        <>
          <Toggle
            label="Use the app’s defaults for these"
            checked={value.book === null}
            onChange={(on) => onChange({ ...value, book: on ? null : structuredClone(app.book) })}
            hint={value.book === null ? '(File → Settings)' : `— ${scope} has its own`}
          />
          {value.book === null ? (
            <p className="muted small">New books in {scope} start from the app’s defaults. Untick the box to give {scope} its own author, copyright page, front and back matter, and export choices.</p>
          ) : (
            <>
              <p className="muted small">New books marked for export in {scope} start from these (books you have already set up keep their own).</p>
              {tab === 'title' && <TitleCopyrightForm template details={value.book} set={setBook} />}
              {tab === 'front' && <FrontMatterForm template details={value.book} set={setBook} />}
              {tab === 'back' && <BackMatterForm template details={value.book} set={setBook} />}
              {tab === 'export' && (
                <>
                  <section>
                    <h4>Save to</h4>
                    <Field label="Output folder" value={value.book.export.outputDir} onChange={(v) => editBook((d) => void (d.export.outputDir = v))} hint="A relative name is created beside each manuscript." />
                  </section>
                  <OutputsForm template details={value.book} edit={editBook} />
                  <TextForm template details={value.book} edit={editBook} />
                </>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}
