import { useEffect, useState } from 'react';
import type { UnsavedChoice } from '../shared/api';
import type { Dialogs } from '../shared/backend/coreApi';

interface Spec {
  title: string;
  detail?: string;
  buttons: { label: string; value: string; kind?: 'primary' | 'danger' }[];
  /** What closing the dialog (tapping outside, Back) means. */
  cancel: string;
}

let show: ((s: (Spec & { resolve(v: string): void }) | null) => void) | null = null;

/** Asks the user and resolves to the chosen button's value. Needs `<DialogHost />` mounted. */
function ask(spec: Spec): Promise<string> {
  return new Promise((resolve) => {
    if (!show) return resolve(spec.cancel);
    show({ ...spec, resolve });
  });
}

/** In-app stand-ins for the desktop's native message boxes (same wording and choices). */
export const mobileDialogs: Dialogs = {
  async confirmUnsaved(fileName): Promise<UnsavedChoice> {
    return (await ask({
      title: `Save the changes to ${fileName}?`,
      detail: "Your changes will be lost if you don't save them.",
      buttons: [{ label: 'Save', value: 'save', kind: 'primary' }, { label: "Don't Save", value: 'discard' }, { label: 'Cancel', value: 'cancel' }],
      cancel: 'cancel',
    })) as UnsavedChoice;
  },
  async confirmOverwrite(fileName) {
    return (
      (await ask({
        title: `${fileName} changed since you opened it.`,
        detail: 'Saving now will overwrite those changes.',
        buttons: [{ label: 'Overwrite', value: 'yes', kind: 'danger' }, { label: 'Cancel', value: 'no' }],
        cancel: 'no',
      })) === 'yes'
    );
  },
  async confirmDelete(name, kind, hasUnsaved) {
    const where = kind === 'chapter' ? 'This removes the chapter and its text from the file.' : 'It will be moved to the trash.';
    return (
      (await ask({
        title: `Delete the ${kind} “${name}”?`,
        detail: hasUnsaved ? `${where} Unsaved edits to it will be lost.` : where,
        buttons: [{ label: 'Delete', value: 'yes', kind: 'danger' }, { label: 'Cancel', value: 'no' }],
        cancel: 'no',
      })) === 'yes'
    );
  },
  async confirmRecover(fileName) {
    return (
      (await ask({
        title: `Recover unsaved changes to ${fileName}?`,
        detail: 'MDEdit closed unexpectedly last time. These edits were autosaved but never written to the file.',
        buttons: [{ label: 'Recover', value: 'yes', kind: 'primary' }, { label: 'Discard', value: 'no' }],
        cancel: 'no',
      })) === 'yes'
    );
  },
  async confirmMarkEdited(chapterTitle) {
    return (
      (await ask({
        title: `Mark “${chapterTitle}” as edited?`,
        detail: 'Edited chapters show a green dot in the file list.',
        buttons: [{ label: 'Mark Edited', value: 'yes', kind: 'primary' }, { label: 'Not Yet', value: 'no' }],
        cancel: 'no',
      })) === 'yes'
    );
  },
};

export function DialogHost() {
  const [spec, setSpec] = useState<(Spec & { resolve(v: string): void }) | null>(null);
  useEffect(() => {
    show = setSpec;
    return () => {
      show = null;
    };
  }, []);
  if (!spec) return null;
  const done = (v: string) => {
    spec.resolve(v);
    setSpec(null);
  };
  return (
    <div className="modal-backdrop" onClick={(e) => e.target === e.currentTarget && done(spec.cancel)}>
      <div className="modal" role="alertdialog" aria-modal="true" aria-label={spec.title}>
        <h3>{spec.title}</h3>
        {spec.detail && <p className="modal-hint">{spec.detail}</p>}
        <div className="modal-actions">
          {spec.buttons.map((b) => (
            <button key={b.value} type="button" className={b.kind} onClick={() => done(b.value)}>
              {b.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
