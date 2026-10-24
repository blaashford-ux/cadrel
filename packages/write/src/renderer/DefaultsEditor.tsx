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

/**
 * Chapter heading level and book defaults for a project or template. Everything is always shown: read-only with the
 * app's values until "Override" is ticked, then editable (starting from a copy of the app's values).
 */
export function DefaultsEditor({ value, app, scope, onChange }: Props) {
  const [tab, setTab] = useState<Tab>('chapters');
  const overridingBook = value.book !== null;
  const book = value.book ?? app.book;
  const setBook = (patch: Partial<BookDetails>) => value.book && onChange({ ...value, book: { ...value.book, ...patch } });
  const editBook = (fn: (d: BookDetails) => void) => {
    if (!value.book) return;
    const next = structuredClone(value.book);
    fn(next);
    onChange({ ...value, book: next });
  };
  const overridingLevel = value.chapterLevel !== null;

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
            label="Override the app setting"
            checked={overridingLevel}
            onChange={(on) => onChange({ ...value, chapterLevel: on ? app.chapterLevel : null })}
            hint={overridingLevel ? `— ${scope} has its own` : '(from File → Settings)'}
          />
          <fieldset className={`defaults-fields${overridingLevel ? '' : ' readonly'}`} disabled={!overridingLevel}>
            <Select<number>
              label={`A chapter in ${scope} starts at`}
              value={value.chapterLevel ?? app.chapterLevel}
              options={LEVELS}
              onChange={(v) => onChange({ ...value, chapterLevel: v })}
              hint="Used for the editor and for exports from this level of the app."
            />
          </fieldset>
        </section>
      )}

      {tab !== 'chapters' && (
        <>
          <Toggle
            label="Override the app’s defaults for these"
            checked={overridingBook}
            onChange={(on) => onChange({ ...value, book: on ? structuredClone(app.book) : null })}
            hint={overridingBook ? `— ${scope} has its own` : '(from File → Settings)'}
          />
          <p className="muted small">
            {overridingBook
              ? `New books marked for export in ${scope} start from these (books you have already set up keep their own).`
              : `These are the app’s defaults, which new books in ${scope} start from. Tick Override to give ${scope} its own author, copyright page, front and back matter, and export choices.`}
          </p>
          <fieldset className={`defaults-fields${overridingBook ? '' : ' readonly'}`} disabled={!overridingBook}>
            {tab === 'title' && <TitleCopyrightForm template details={book} set={setBook} />}
            {tab === 'front' && <FrontMatterForm template details={book} set={setBook} />}
            {tab === 'back' && <BackMatterForm template details={book} set={setBook} />}
            {tab === 'export' && (
              <>
                <section>
                  <h4>Save to</h4>
                  <Field label="Output folder" value={book.export.outputDir} onChange={(v) => editBook((d) => void (d.export.outputDir = v))} hint="A relative name is created beside each manuscript." />
                </section>
                <OutputsForm template details={book} edit={editBook} />
                <TextForm template details={book} edit={editBook} />
              </>
            )}
          </fieldset>
        </>
      )}
    </div>
  );
}
