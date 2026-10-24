import { BrowserWindow, dialog, type MessageBoxOptions } from 'electron';
import type { UnsavedChoice } from '../src/shared/api';

async function show(win: BrowserWindow | null, opts: MessageBoxOptions): Promise<number> {
  const { response } = win ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts);
  return response;
}

/** Windows-style Save / Don't Save / Cancel. Escape or closing the dialog means Cancel. */
export async function confirmUnsaved(win: BrowserWindow | null, fileName: string): Promise<UnsavedChoice> {
  const response = await show(win, {
    type: 'warning',
    title: 'MDEdit',
    message: `Do you want to save the changes to ${fileName}?`,
    detail: "Your changes will be lost if you don't save them.",
    buttons: ['Save', "Don't Save", 'Cancel'],
    defaultId: 0,
    cancelId: 2,
    noLink: true
  });
  return (['save', 'discard', 'cancel'] as const)[response] ?? 'cancel';
}

export async function confirmOverwrite(win: BrowserWindow | null, fileName: string): Promise<boolean> {
  const response = await show(win, {
    type: 'warning',
    title: 'MDEdit',
    message: `${fileName} was changed on disk since you opened it.`,
    detail: 'Saving now will overwrite those changes.',
    buttons: ['Overwrite', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    noLink: true
  });
  return response === 0;
}

export async function confirmDelete(
  win: BrowserWindow | null,
  name: string,
  kind: 'file' | 'folder' | 'chapter',
  hasUnsaved: boolean
): Promise<boolean> {
  const where = kind === 'chapter' ? 'This removes the chapter and its text from the file.' : 'It will be moved to the Recycle Bin.';
  const response = await show(win, {
    type: 'warning',
    title: 'MDEdit',
    message: `Delete the ${kind} "${name}"?`,
    detail: hasUnsaved ? `${where} Unsaved edits to it will be lost.` : where,
    buttons: ['Delete', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    noLink: true
  });
  return response === 0;
}

export async function confirmRecover(win: BrowserWindow | null, fileName: string): Promise<boolean> {
  const response = await show(win, {
    type: 'question',
    title: 'MDEdit',
    message: `Recover unsaved changes to ${fileName}?`,
    detail: 'MDEdit closed unexpectedly last time. These edits were autosaved but never written to the file.',
    buttons: ['Recover', 'Discard'],
    defaultId: 0,
    cancelId: 1,
    noLink: true
  });
  return response === 0;
}

export async function confirmMarkEdited(win: BrowserWindow | null, chapterTitle: string): Promise<boolean> {
  const response = await show(win, {
    type: 'question',
    title: 'MDEdit',
    message: `Mark "${chapterTitle}" as edited?`,
    detail: 'Edited chapters show a green dot in the file list.',
    buttons: ['Mark Edited', 'Not Yet'],
    defaultId: 0,
    cancelId: 1,
    noLink: true
  });
  return response === 0;
}
