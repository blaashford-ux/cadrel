/** Tidy extracted text: consistent newlines, no stray control characters, paragraphs separated by one blank line. */
export function normalizeText(s: string): string {
  return s
    .replace(/^﻿/, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F­​]/g, '')
    .replace(/ /g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Join hard-wrapped lines into paragraphs; blank lines separate paragraphs. Hyphenated line ends are re-joined. */
export function unwrap(s: string): string {
  return s
    .split(/\n\s*\n/)
    .map((p) => p.split('\n').map((l) => l.trim()).filter(Boolean).reduce((acc, l) => (acc.endsWith('-') && /^[a-z]/.test(l) ? acc.slice(0, -1) + l : acc ? acc + ' ' + l : l), ''))
    .filter(Boolean)
    .join('\n\n');
}
