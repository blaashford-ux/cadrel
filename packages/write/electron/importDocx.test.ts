import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Document, HeadingLevel, Packer, Paragraph, TextRun } from 'docx';
import { importDocxFiles } from './importDocx';

describe('importDocxFiles', () => {
  it('writes a same-named .md, avoids clashes and reports bad files', async () => {
    const tmp = mkdtempSync(path.join(tmpdir(), 'imp-'));
    const out = path.join(tmp, 'out');
    require('node:fs').mkdirSync(out);
    const docx = await Packer.toBuffer(new Document({ sections: [{ children: [new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun({ text: 'Hi', bold: true })] })] }] }));
    const good = path.join(tmp, 'Story.docx');
    writeFileSync(good, docx);
    const bad = path.join(tmp, 'Broken.docx');
    writeFileSync(bad, 'nope');

    const first = await importDocxFiles(out, [good, bad]);
    expect(first.created).toEqual([path.join(out, 'Story.md')]);
    expect(first.failed).toHaveLength(1);
    expect(readFileSync(first.created[0], 'utf8')).toBe('# **Hi**\n');
    expect(existsSync(path.join(out, 'Broken.md'))).toBe(false);

    const second = await importDocxFiles(out, [good]);
    expect(second.created).toEqual([path.join(out, 'Story (2).md')]);
  });
});
