import { useState } from 'react';
import type { Overrides } from '../shared/export/layers';
import type { BookDetails } from '../shared/export/model';
import { BackMatterForm, FrontMatterForm, TitleCopyrightForm } from './bookForms';
import { OutputsForm, TextForm } from './exportForms';
import { Field, Select, Toggle } from './formParts';
import { LayerProvider, layerEditor } from './layerEditor';

type Tab = 'chapters' | 'title' | 'front' | 'back' | 'export';

export interface ProjectDefaultsValue {
  /** null = use the app's setting. */
  chapterLevel: number | null;
  /** The book fields this project sets itself; every other field follows the app. */
  book: Overrides;
}

interface Props {
  value: ProjectDefaultsValue;
  /** What the project inherits. */
  app: { chapterLevel: number; book: BookDetails };
  onChange(value: ProjectDefaultsValue): void;
}

const LEVELS = [1, 2, 3, 4, 5, 6].map((n) => ({ value: n, label: `Heading ${n}  (${'#'.repeat(n)} Title)` }));

/**
 * A project's book defaults, field by field: each shows the app's value until the project changes it, and Reset
 * hands it back. Books in the project follow these unless they set a field themselves.
 */
export function ProjectDefaultsEditor({ value, app, onChange }: Props) {
  const [tab, setTab] = useState<Tab>('chapters');
  const layer = layerEditor({
    inherited: app.book,
    state: { overrides: value.book },
    scope: 'project',
    onChange: (s) => onChange({ ...value, book: s.overrides })
  });
  const { details, edit, set } = layer;
  const own = Object.keys(value.book).length;

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
              label="A chapter in this project starts at"
              value={value.chapterLevel}
              options={LEVELS}
              onChange={(v) => onChange({ ...value, chapterLevel: v })}
              hint="Used for the editor and for exports from this level of the app."
            />
          )}
        </section>
      )}

      {tab !== 'chapters' && (
        <LayerProvider value={layer}>
          <p className="muted small">
            Every book in this project follows these settings unless it sets a field itself. Each field shows the app’s value until you change it here; Reset hands it back to the app.{' '}
            {own === 0 ? 'This project doesn’t set any yet.' : `This project sets ${own} field${own === 1 ? '' : 's'}.`}
          </p>
          {tab === 'title' && <TitleCopyrightForm template details={details} set={set} />}
          {tab === 'front' && <FrontMatterForm template details={details} set={set} />}
          {tab === 'back' && <BackMatterForm template details={details} set={set} />}
          {tab === 'export' && (
            <>
              <section>
                <h4>Save to</h4>
                <Field
                  label="Output folder"
                  path="export.outputDir"
                  value={details.export.outputDir}
                  onChange={(v) => edit((d) => void (d.export.outputDir = v))}
                  hint="A relative name is created beside each manuscript."
                />
              </section>
              <OutputsForm template details={details} edit={edit} />
              <TextForm template details={details} edit={edit} />
            </>
          )}
        </LayerProvider>
      )}
    </div>
  );
}

