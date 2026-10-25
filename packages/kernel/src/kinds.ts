/**
 * File kinds: how Cadrel (and the assistant) know what a file is. A kind is a field in a file's catalog record, not something
 * inside the file, so prose stays pure Markdown and non-text files get a kind too. Kinds are data: this is the built-in set
 * a studio starts with, and a studio can add its own (see docs/FILES.md).
 */

/** The part of the permission model a kind falls under (the rows of the matrix in docs/PERMISSIONS.md). */
export type KindArea = 'manuscripts' | 'canon' | 'assets' | 'launch' | 'none';
/** What the assistant may do with files of this kind by default. */
export type KindAi = 'read' | 'notes' | 'none';

export interface FileKind {
  id: string;
  name: string;
  /** Read by the assistant, so a studio's own kind explains itself. */
  description: string;
  /** Running text with chapters: has word counts, a chapter index, goals, an editor. */
  prose: boolean;
  /** Its words count toward goals and dashboards. */
  counts: boolean;
  /** Part of a book build (EPUB, DOCX, print). */
  exportable: boolean;
  /** Feeds Continuity and the series bible. */
  canon: boolean;
  area: KindArea;
  ai: KindAi;
  /** Extensions it normally has, lower case with the dot. */
  ext: string[];
  /** The template folder name it defaults to. */
  folder: string | null;
  builtin: boolean;
}

const MD = ['.md', '.markdown'];
export const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.tif', '.tiff', '.bmp'];

const k = (id: string, name: string, description: string, rest: Partial<FileKind> & Pick<FileKind, 'area'>): FileKind => ({
  id, name, description, prose: false, counts: false, exportable: false, canon: false, ai: 'read', ext: [], folder: null, builtin: true, ...rest
});

export const BUILT_IN_KINDS: FileKind[] = [
  k('manuscript', 'Manuscript', 'The text of a book: one or more drafts. This is what is edited, counted, exported and reviewed.', { prose: true, counts: true, exportable: true, canon: true, ai: 'notes', area: 'manuscripts', ext: MD, folder: 'Manuscript' }),
  k('matter', 'Front and back matter', 'Title page, dedication, copyright page, about the author, also by.', { prose: true, exportable: true, ai: 'notes', area: 'manuscripts', ext: MD }),
  k('outline', 'Outline', 'Beats and the chapter-by-chapter plan.', { prose: true, canon: true, area: 'canon', ext: MD, folder: 'Outline' }),
  k('premise', 'Premise', 'The concept: logline, pitch, series arc.', { prose: true, canon: true, area: 'canon', ext: MD, folder: 'Premise' }),
  k('character', 'Character', 'A character sheet: who they are, what they want, how they speak.', { prose: true, canon: true, area: 'canon', ext: MD, folder: 'Characters' }),
  k('world', 'Worldbuilding', 'Places, magic and rules, history, culture: reference for the story world.', { prose: true, canon: true, area: 'canon', ext: MD, folder: 'Worldbuilding' }),
  k('research', 'Research', 'Notes and source material the author gathered. Not part of the story.', { area: 'canon', ext: [...MD, '.pdf', '.txt'], folder: 'Research' }),
  k('style', 'Style sheet', 'Voice notes, spelling and naming choices.', { prose: true, area: 'canon', ext: MD }),
  k('brief', 'Brief', 'A brief for cover art, a blurb or a campaign.', { prose: true, area: 'assets', ext: MD }),
  k('copy', 'Marketing copy', 'Blurbs, descriptions, ad text, newsletter copy.', { prose: true, area: 'launch', ext: MD }),
  k('image', 'Image', 'A picture: cover art, map, character art, a reference or inspiration image, a photo.', { area: 'assets', ext: IMAGE_EXTENSIONS, folder: 'Images' }),
  k('asset', 'Production file', 'A source or working file that is not a plain picture: layered art (PSD), fonts, design files.', { area: 'assets', ext: ['.psd', '.ai', '.xcf', '.kra', '.ttf', '.otf'] }),
  k('export', 'Export', 'A generated file: EPUB, PDF, DOCX. Rebuilt from a manuscript, never edited by hand.', { ai: 'none', area: 'manuscripts', ext: ['.epub', '.pdf', '.docx'], folder: 'Exports' }),
  k('reference', 'Reference', 'An imported file kept as it came, such as a Word draft or a PDF.', { area: 'canon', ext: ['.docx', '.pdf', '.odt'] }),
  k('other', 'Not sorted yet', 'Not classified. Choose a kind so it is treated properly.', { ai: 'none', area: 'none' })
];

export const OTHER_KIND = 'other';

const BY_ID = new Map(BUILT_IN_KINDS.map((x) => [x.id, x]));
export const builtInKind = (id: string): FileKind | undefined => BY_ID.get(id);

/** A lookup over the built-ins plus a studio's own kinds (which may not reuse a built-in id). */
export function kindRegistry(custom: FileKind[] = []): Map<string, FileKind> {
  const m = new Map(BY_ID);
  for (const c of custom) if (!m.has(c.id)) m.set(c.id, { ...c, builtin: false });
  return m;
}

const extOf = (file: string): string => {
  const base = file.split(/[\\/]/).pop() ?? '';
  const i = base.lastIndexOf('.');
  return i <= 0 ? '' : base.slice(i).toLowerCase();
};

export interface KindSuggestion {
  kind: string;
  /** Why, in words the person can check. */
  reason: string;
  /** `folder` is as good as the template; `guess` is only the file's extension or name and should be confirmed. */
  confidence: 'folder' | 'guess';
}

/**
 * A suggestion for a file that has no kind yet: the nearest folder that has one (`folderKinds`: folder path to kind, "/" separated),
 * else what its extension says. Never decides: the caller shows it and a person accepts it.
 */
export function suggestKind(path: string, folderKinds: Record<string, string> = {}, kinds: Map<string, FileKind> = kindRegistry()): KindSuggestion {
  const parts = path.replace(/\\/g, '/').split('/');
  for (let n = parts.length - 1; n >= 1; n--) {
    const folder = parts.slice(0, n).join('/');
    const kind = folderKinds[folder];
    if (kind && kinds.has(kind) && kind !== OTHER_KIND) return { kind, reason: `it is in the "${parts[n - 1]}" folder`, confidence: 'folder' };
  }
  const ext = extOf(path);
  if (IMAGE_EXTENSIONS.includes(ext)) return { kind: 'image', reason: `${ext} is a picture`, confidence: 'guess' };
  if (['.psd', '.ai', '.xcf', '.kra'].includes(ext)) return { kind: 'asset', reason: `${ext} is a working design file`, confidence: 'guess' };
  if (['.epub'].includes(ext)) return { kind: 'export', reason: 'an EPUB is a generated book file', confidence: 'guess' };
  if (['.docx', '.odt'].includes(ext)) return { kind: 'reference', reason: 'a word-processor file is kept as imported', confidence: 'guess' };
  if (ext === '.pdf') return { kind: 'research', reason: 'a PDF is usually source material', confidence: 'guess' };
  return { kind: OTHER_KIND, reason: 'nothing says what it is', confidence: 'guess' };
}

/** The folder names a template uses, mapped to kinds (so adopting an MDEdit project can set folder defaults). */
export function folderKindByName(name: string, kinds: Map<string, FileKind> = kindRegistry()): string | null {
  const n = name.trim().toLowerCase();
  const alias: Record<string, string> = { manuscripts: 'manuscript', characters: 'character', 'series bible': 'world', images: 'image', pictures: 'image', art: 'asset', outlines: 'outline' };
  for (const kind of kinds.values()) if (kind.folder && kind.folder.toLowerCase() === n) return kind.id;
  return alias[n] ?? null;
}

/** The glossary the assistant is given: what each kind is for. */
export function kindGlossary(kinds: Map<string, FileKind> = kindRegistry()): string {
  return [...kinds.values()].map((x) => `- ${x.id}: ${x.description}`).join('\n');
}
