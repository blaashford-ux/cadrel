import { describe, expect, it } from 'vitest';
import { defaultBookDetails } from './export/model';
import {
  defaultRootFolder, defaultTemplates, flattenFolders, newProjectMeta, projectNameError, sanitizeProjectMeta, sanitizeTemplate,
  sanitizeTemplates, templateErrors, uncountedFolders, uniqueName, type ProjectTemplate
} from './projects';

const novel = () => defaultTemplates().find((t) => t.id === 'novel')!;

describe('built-in templates', () => {
  it('ships Novel, Series Book, Short Story and Blank, all valid', () => {
    const ts = defaultTemplates();
    expect(ts.map((t) => t.name)).toEqual(['Novel', 'Series', 'Short Story', 'Blank']);
    for (const t of ts) expect(templateErrors(t)).toEqual([]);
  });
  it('Novel makes the expected folders and counts only the manuscript', () => {
    expect(flattenFolders(novel().folders)).toEqual(['Manuscript', 'Characters', 'Worldbuilding', 'Research', 'Exports']);
    expect(uncountedFolders(novel().folders)).toEqual(['Characters', 'Worldbuilding', 'Research', 'Exports']);
  });
  it('Blank has no folders, so everything counts', () => {
    const b = defaultTemplates().find((t) => t.id === 'blank')!;
    expect(flattenFolders(b.folders)).toEqual([]);
    expect(uncountedFolders(b.folders)).toEqual([]);
  });
});

describe('folder trees', () => {
  const tree = [
    { name: 'Manuscript', counts: true, children: [{ name: 'Part 1', counts: true, children: [] }, { name: 'Outtakes', counts: false, children: [{ name: 'Old', counts: true, children: [] }] }] },
    { name: 'Notes', counts: false, children: [{ name: 'Maps', counts: true, children: [] }] }
  ];
  it('flattens in creation order with paths', () => {
    expect(flattenFolders(tree)).toEqual(['Manuscript', 'Manuscript/Part 1', 'Manuscript/Outtakes', 'Manuscript/Outtakes/Old', 'Notes', 'Notes/Maps']);
  });
  it('an uncounted folder excludes everything below it, and parents subsume children', () => {
    expect(uncountedFolders(tree)).toEqual(['Manuscript/Outtakes', 'Notes']);
  });
});

describe('template validation', () => {
  const t = (folders: ProjectTemplate['folders']): ProjectTemplate => ({ ...novel(), folders });
  it('rejects bad, reserved and duplicate folder names', () => {
    expect(templateErrors(t([{ name: 'a/b', counts: true, children: [] }])).join()).toMatch(/cannot contain/);
    expect(templateErrors(t([{ name: 'CON', counts: true, children: [] }])).join()).toMatch(/reserved/);
    expect(templateErrors(t([{ name: 'A', counts: true, children: [] }, { name: 'a', counts: true, children: [] }])).join()).toMatch(/appears twice/);
  });
  it('limits nesting depth and total folders', () => {
    let deep: ProjectTemplate['folders'] = [];
    for (let i = 8; i > 0; i--) deep = [{ name: `L${i}`, counts: true, children: deep }];
    expect(templateErrors(t(deep)).join()).toMatch(/at most 6 levels/);
    const many = Array.from({ length: 201 }, (_, i) => ({ name: `F${i}`, counts: true, children: [] }));
    expect(templateErrors(t(many)).join()).toMatch(/at most 200/);
  });
  it('needs a name and safe starter-file paths', () => {
    expect(templateErrors({ ...novel(), name: ' ' }).join()).toMatch(/needs a name/);
    expect(templateErrors({ ...novel(), files: [{ path: '../evil.md', content: '' }] }).join()).toMatch(/invalid path/);
  });
});

describe('sanitising templates', () => {
  it('drops hostile paths, junk fields and empty names; clamps the chapter level', () => {
    const s = sanitizeTemplate({ id: 'My T!', name: ' Mine ', folders: [{ name: 'A', children: [{ name: '' }] }, 5], files: [{ path: '../x.md', content: 'x' }, { path: 'A\\ok.md', content: 'hi' }], chapterLevel: 9 })!;
    expect(s.id).toBe('My-T-');
    expect(s.name).toBe('Mine');
    expect(s.folders).toEqual([{ name: 'A', counts: true, children: [] }]);
    expect(s.files).toEqual([{ path: 'A/ok.md', content: 'hi' }]);
    expect(s.chapterLevel).toBe(6);
    expect(s.book).toBeNull();
  });
  it('keeps book defaults, cleaned', () => {
    const book = defaultBookDetails({ title: 'x', author: 'Me' });
    expect(sanitizeTemplate({ id: 'a', name: 'A', book })!.book!.author).toBe('Me');
  });
  it('rejects nonsense and falls back to the built-ins when nothing is usable', () => {
    expect(sanitizeTemplate(null)).toBeNull();
    expect(sanitizeTemplate({ name: 'no id' })).toBeNull();
    expect(sanitizeTemplates('x').map((x) => x.id)).toEqual(['novel', 'series', 'short-story', 'blank']);
    expect(sanitizeTemplates([]).length).toBe(4);
  });
  it('makes duplicate ids unique', () => {
    const l = sanitizeTemplates([{ id: 'a', name: 'A' }, { id: 'a', name: 'B' }, { id: 'a', name: 'C' }]);
    expect(l.map((x) => x.id)).toEqual(['a', 'a-2', 'a-3']);
  });
});

describe('project metadata', () => {
  const now = new Date('2026-10-05T10:00:00Z');
  it('a new project copies the template’s defaults, not shares them', () => {
    const t = { ...novel(), chapterLevel: 2, book: defaultBookDetails({ title: '', author: 'Template Author' }) };
    const m = newProjectMeta({ id: 'p1', name: 'The Lost King', template: t, now });
    expect(m).toMatchObject({ name: 'The Lost King', templateId: 'novel', templateName: 'Novel', status: 'planning', archived: false, goal: null, createdAt: now.toISOString() });
    expect(m.excludedFolders).toEqual(['Characters', 'Worldbuilding', 'Research', 'Exports']);
    expect(m.overrides.chapterLevel).toBe(2);
    expect(m.overrides.book!.author).toBe('Template Author');
    m.overrides.book!.author = 'changed';
    expect(t.book!.author).toBe('Template Author');
  });
  it('round-trips through sanitising', () => {
    const m = newProjectMeta({ id: 'p1', name: 'X', template: novel(), now });
    m.goal = { targetWords: 80000, startDate: '2026-10-05', targetDate: '2027-01-31' };
    m.status = 'drafting';
    expect(sanitizeProjectMeta(JSON.parse(JSON.stringify(m)), 'X', '2026-10-05')).toEqual(m);
  });
  it('survives garbage', () => {
    const m = sanitizeProjectMeta({ status: 'nonsense', goal: { targetWords: -4 }, excludedFolders: ['../x', 'ok', 5], overrides: 'x' }, 'Folder Name', '2026-10-05');
    expect(m.name).toBe('Folder Name');
    expect(m.status).toBe('planning');
    expect(m.goal).toBeNull();
    expect(m.excludedFolders).toEqual(['ok']);
    expect(m.overrides).toEqual({ chapterLevel: null, book: null });
    expect(sanitizeProjectMeta(null, 'F', '2026-10-05').name).toBe('F');
  });
});

describe('names', () => {
  it('applies the file-name rules plus no leading dot and no clashes (case-insensitive)', () => {
    expect(projectNameError('')).toMatch(/empty/);
    expect(projectNameError('a:b')).toMatch(/cannot contain/);
    expect(projectNameError('.hidden')).toMatch(/period/);
    expect(projectNameError('NUL')).toMatch(/reserved/);
    expect(projectNameError('The Lost King', ['the lost king'])).toMatch(/already/);
    expect(projectNameError('The Lost King', ['Other'])).toBeNull();
  });
  it('picks the next free name', () => {
    expect(uniqueName('Book', ['Other'])).toBe('Book');
    expect(uniqueName('Book', ['book', 'Book 2'])).toBe('Book 3');
  });
  it('default root is <home>\\MDEdit', () => {
    expect(defaultRootFolder('C:\\Users\\Me')).toBe('C:\\Users\\Me\\MDEdit');
    expect(defaultRootFolder('/home/me/')).toBe('/home/me/MDEdit');
  });
});

import { defaultProjectsSettings, sanitizeProjectsSettings } from './projects';
describe('projects settings', () => {
  it('defaults: no root chosen yet, built-in templates, Novel default, reopen last', () => {
    const d = defaultProjectsSettings();
    expect(d).toMatchObject({ rootFolder: null, setupDone: false, defaultTemplateId: 'novel', reopenLast: true, lastProject: null });
    expect(d.templates).toHaveLength(4);
  });
  it('sanitises garbage and keeps valid choices', () => {
    expect(sanitizeProjectsSettings('x')).toEqual(defaultProjectsSettings());
    const s = sanitizeProjectsSettings({ rootFolder: ' D:\\Writing ', setupDone: true, templates: [{ id: 'mine', name: 'Mine' }], defaultTemplateId: 'gone', reopenLast: false, lastProject: 'D:\\Writing\\Book' });
    expect(s).toMatchObject({ rootFolder: 'D:\\Writing', setupDone: true, defaultTemplateId: 'mine', reopenLast: false, lastProject: 'D:\\Writing\\Book' });
    expect(s.templates.map((t) => t.id)).toEqual(['mine']);
  });
});

import { defaultAppDefaults, sanitizeAppDefaults } from './appDefaults';
import { effectiveDefaults } from './projects';
describe('defaults cascade', () => {
  const app = sanitizeAppDefaults({ chapterLevel: 2, book: { author: 'App Author' } });
  const meta = (o: Partial<ReturnType<typeof newProjectMeta>['overrides']>) => ({ ...newProjectMeta({ id: 'x', name: 'x', template: defaultTemplates()[3], now: new Date() }), overrides: { chapterLevel: null, book: null, ...o } });
  it('outside a project, or with nothing overridden, the app defaults apply', () => {
    expect(effectiveDefaults(app, null)).toBe(app);
    expect(effectiveDefaults(app, meta({}))).toEqual(app);
  });
  it('a project’s chapter level and book defaults win independently', () => {
    const book = sanitizeAppDefaults({ book: { author: 'Project Author' } }).book;
    expect(effectiveDefaults(app, meta({ chapterLevel: 3 }))).toEqual({ chapterLevel: 3, book: app.book });
    const both = effectiveDefaults(app, meta({ book }));
    expect(both.chapterLevel).toBe(2);
    expect(both.book.author).toBe('Project Author');
    expect(defaultAppDefaults().chapterLevel).toBe(1);
  });
});

import { goalFor, relativeTo, withGoal } from './projects';
import { defaultTemplates as templatesForManuscriptTests } from './projects';

describe('active manuscript', () => {
  const meta = () => newProjectMeta({ id: 'x', name: 'S', template: templatesForManuscriptTests().find((t) => t.id === 'series')!, now: new Date('2026-10-05T10:00:00Z') });
  const g = { targetWords: 90000, startDate: '2026-10-05', targetDate: null };
  it('the Series template has a Manuscripts folder and no book files', () => {
    const t = templatesForManuscriptTests().find((x) => x.id === 'series')!;
    expect(t.name).toBe('Series');
    expect(t.folders.map((f) => f.name)).toContain('Manuscripts');
    expect(t.files.map((f) => f.path).filter((f) => f.startsWith('Manuscripts'))).toEqual([]);
  });
  it('goalFor follows the active manuscript, otherwise the project goal', () => {
    let m = withGoal(meta(), g);
    expect(goalFor(m)).toEqual(g);
    m = { ...m, activeManuscript: 'Manuscripts/Book 1.md' };
    expect(goalFor(m)).toBeNull();
    m = withGoal(m, { ...g, targetWords: 70000 });
    expect(goalFor(m)?.targetWords).toBe(70000);
    expect(m.goal?.targetWords).toBe(90000); // the project goal is untouched
    expect(goalFor(withGoal(m, null))).toBeNull();
  });
  it('is sanitised: bad paths and goals are dropped', () => {
    const m = sanitizeProjectMeta({ ...meta(), activeManuscript: '../evil.md', manuscriptGoals: { 'A/b.md': g, '../x.md': g, 'C.md': { targetWords: -1 } } }, 'S', '2026-10-05');
    expect(m.activeManuscript).toBeNull();
    expect(Object.keys(m.manuscriptGoals)).toEqual(['A/b.md']);
  });
  it('relativeTo gives "/" paths inside the project', () => {
    expect(relativeTo('C:\\Root\\P', 'C:\\Root\\P\\Manuscripts\\Book 1.md')).toBe('Manuscripts/Book 1.md');
    expect(relativeTo('/r/P', '/r/P/a/b.md')).toBe('a/b.md');
  });
});
