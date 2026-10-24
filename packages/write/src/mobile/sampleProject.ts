import { MemoryFs } from '../shared/memoryFs';

/** A small library for the browser preview (no device needed), so the UI can be exercised and screenshotted. */
export function seededPreviewFs(): MemoryFs {
  const fs = new MemoryFs();
  const book = `# Chapter One\n\nThe harbour woke slowly. Gulls argued over the night's scraps while the first boats pushed out into a grey, patient sea.\n\nMara counted the coins twice. It was still not enough.\n\n* * *\n\n# Chapter Two\n\nThe letter arrived with the tide, sealed in wax the colour of old blood.\n\n# Chapter Three\n\nNobody in the village would say his name aloud.\n`;
  fs.seed('/MDEdit/The Lost King/Manuscript/The Lost King.md', book);
  fs.seed('/MDEdit/The Lost King/Characters/Mara.md', '# Mara\n\nHarbour girl, sharp with numbers, sharper with her tongue.\n');
  fs.seed('/MDEdit/The Lost King/Worldbuilding/The Coast.md', '# The Coast\n\nSalt, rope and long memories.\n');
  fs.seed('/MDEdit/The Lost King/.mdedit/project.json', JSON.stringify({ version: 1, id: 'p1', name: 'The Lost King', templateId: 'novel', templateName: 'Novel', createdAt: '2026-09-01T10:00:00.000Z', status: 'drafting' }));
  fs.seed('/MDEdit/Short Stories/Drafts/Lantern.md', '# Lantern\n\nA small light in a large dark.\n');
  fs.seed('/MDEdit/Short Stories/.mdedit/project.json', JSON.stringify({ version: 1, id: 'p2', name: 'Short Stories', templateId: 'short-story', templateName: 'Short Story', createdAt: '2026-09-10T10:00:00.000Z', status: 'planning' }));
  return fs;
}
