/** The two kinds of text surface the app edits in: the Markdown source box and the formatted (ProseMirror) editor. */
export const EDITABLE = 'textarea.source-editor, .ProseMirror';

export const isEditable = (el: HTMLElement) => !!el.closest(EDITABLE);

const isTextarea = (el: Element): el is HTMLTextAreaElement => el instanceof HTMLTextAreaElement;

function selectedText(host: HTMLElement): string {
  if (isTextarea(host)) return host.value.slice(host.selectionStart, host.selectionEnd);
  return window.getSelection()?.toString() ?? '';
}

async function writeClipboard(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const t = document.createElement('textarea');
    t.value = text;
    t.style.cssText = 'position:fixed;opacity:0;left:-9999px';
    document.body.appendChild(t);
    t.select();
    document.execCommand('copy');
    t.remove();
  }
}

/** Puts `text` into the editor the way typing would, so undo and the unsaved-changes tracking see it. */
function insert(host: HTMLElement, text: string) {
  host.focus();
  if (!isTextarea(host)) {
    // The formatted editor handles paste itself (it splits paragraphs and strips formatting).
    const data = new DataTransfer();
    data.setData('text/plain', text);
    const ev = new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true });
    host.dispatchEvent(ev);
    if (ev.defaultPrevented) return;
  }
  if (!document.execCommand('insertText', false, text) && isTextarea(host)) {
    host.setRangeText(text, host.selectionStart, host.selectionEnd, 'end');
    host.dispatchEvent(new Event('input', { bubbles: true }));
  }
}

/** The editor that has the caret (the formatted editor or the source box), if any. */
export function activeEditor(): HTMLElement | null {
  const a = document.activeElement;
  return a instanceof HTMLElement ? a.closest<HTMLElement>(EDITABLE) : null;
}

/** Is any text selected in `host`? */
export function hasSelection(host: HTMLElement): boolean {
  return selectedText(host).length > 0;
}

export function copySelection(host: HTMLElement): void {
  const text = selectedText(host);
  if (text) void writeClipboard(text);
}

export function cutSelection(host: HTMLElement): void {
  const text = selectedText(host);
  if (!text) return;
  host.focus();
  if (!document.execCommand('cut')) {
    void writeClipboard(text);
    document.execCommand('delete');
  }
}

export function pasteInto(host: HTMLElement): void {
  void navigator.clipboard
    .readText()
    .then((t) => t && insert(host, t))
    .catch(() => host.focus()); // clipboard read refused: nothing to paste
}
