import { strFromU8, unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { buildKit, KIT_FOLDER, type KitBrand, type KitFile, type KitSkill } from './kit';

const skills: KitSkill[] = [
  { name: 'cadrel-line-edit', id: 'line_edit', tag: 'Line edit', markdown: '---\nname: cadrel-line-edit\ndescription: "x"\n---\n\n# Line Edit\n', body: '# Line Edit' },
  { name: 'cadrel-copy-edit', id: 'copy_edit', tag: 'Copy edit', markdown: '---\nname: cadrel-copy-edit\ndescription: "y"\n---\n\n# Copy Edit\n', body: '# Copy Edit' },
];
const server = new TextEncoder().encode('console.log("server")');
const kit = buildKit({ skills, server, version: '0.6.0', root: 'C:\\Users\\me\\Cadrel Write', serverPath: 'C:\\Users\\me\\Downloads\\Cadrel Write AI Kit\\cadrel-write-mcp.js' });
const file = (p: string): KitFile => kit.find((f) => f.path === p)!;

describe('the AI Kit', () => {
  it('lists every file, all with safe relative paths', () => {
    expect(kit.map((f) => f.path).sort()).toEqual([
      'README.txt',
      'connect-settings.txt',
      'for-gpt/cadrel-copy-edit.md',
      'for-gpt/cadrel-line-edit.md',
      'cadrel-write-mcp.js',
      'cadrel-write.mcpb',
      'skills/folders/cadrel-copy-edit/SKILL.md',
      'skills/folders/cadrel-line-edit/SKILL.md',
      'skills/cadrel-copy-edit.zip',
      'skills/cadrel-line-edit.zip',
    ].sort());
    for (const f of kit) expect(f.path).not.toMatch(/^\/|\.\.|\\|:/);
    expect(KIT_FOLDER).toBe('Cadrel Write AI Kit');
  });

  it('makes a Claude Desktop extension that runs the server on the chosen projects folder', () => {
    const files = unzipSync(file('cadrel-write.mcpb').data);
    expect(Object.keys(files).sort()).toEqual(['manifest.json', 'server/index.js']);
    expect(strFromU8(files['server/index.js'])).toBe('console.log("server")');
    const m = JSON.parse(strFromU8(files['manifest.json']));
    expect(m).toMatchObject({ manifest_version: '0.2', name: 'cadrel-write', version: '0.6.0', server: { type: 'node', entry_point: 'server/index.js' } });
    expect(m.server.mcp_config.args).toEqual(['${__dirname}/server/index.js', '--root', '${user_config.root_folder}']);
    expect(m.user_config.root_folder).toMatchObject({ type: 'directory', required: false });
  });

  it('zips each skill with its folder at the top, ready to upload', () => {
    const files = unzipSync(file('skills/cadrel-line-edit.zip').data);
    expect(Object.keys(files)).toEqual(['cadrel-line-edit/SKILL.md']);
    expect(strFromU8(files['cadrel-line-edit/SKILL.md'])).toBe(skills[0].markdown);
  });

  it('gives GPT the instructions with the tag to sign with', () => {
    expect(strFromU8(file('for-gpt/cadrel-line-edit.md').data)).toBe('# Line Edit\n\nWhen you call add_notes, set skill to "Line edit".\n');
  });

  it('writes settings that point at the saved server, and a README that names the steps', () => {
    const s = strFromU8(file('connect-settings.txt').data);
    expect(s).toContain('claude mcp add cadrel-write -- node "C:\\Users\\me\\Downloads\\Cadrel Write AI Kit\\cadrel-write-mcp.js" --root "C:\\Users\\me\\Cadrel Write"');
    expect(s).toContain("[mcp_servers.cadrel-write]");
    const r = strFromU8(file('README.txt').data);
    for (const needle of ['cadrel-write.mcpb', 'Settings > Capabilities > Skills', 'C:\\Users\\me\\Cadrel Write', 'Line edit', 'Copy edit', 'line_edit, copy_edit']) expect(r).toContain(needle);
    expect(file('cadrel-write-mcp.js').data).toBe(server);
  });
});

describe('the AI Kit with authoring skills that carry files', () => {
  const author: KitSkill = { name: 'cadrel-timeline-tracker', id: 'timeline_tracker', tag: 'Timeline Tracker', kind: 'author', markdown: '---\nname: cadrel-timeline-tracker\ndescription: "t"\n---\n\n# Timeline Tracker\n', body: '# Timeline Tracker', files: { 'assets/timeline-view.html': '<html></html>' } };
  const k = buildKit({ skills: [...skills, author], server, version: '0.6.0', root: 'C:\\Cadrel', serverPath: 'C:\\k\\cadrel-write-mcp.js' });
  const f = (p: string) => k.find((x) => x.path === p)!;

  it('zips the skill with its files, and lists them in its folder', () => {
    expect(Object.keys(unzipSync(f('skills/cadrel-timeline-tracker.zip').data)).sort()).toEqual(['cadrel-timeline-tracker/SKILL.md', 'cadrel-timeline-tracker/assets/timeline-view.html']);
    expect(strFromU8(f('skills/folders/cadrel-timeline-tracker/assets/timeline-view.html').data)).toBe('<html></html>');
  });

  it('gives GPT an authoring skill without the notes instruction, and tells the two kinds apart in the README', () => {
    expect(strFromU8(f('for-gpt/cadrel-timeline-tracker.md').data)).toBe('# Timeline Tracker\n');
    const r = strFromU8(f('README.txt').data);
    expect(r).toContain('THE TWO EDITING PASSES');
    expect(r).toContain('THE ONE AUTHORING SKILL');
    expect(r).toContain('(three of them)');
    expect(r).not.toContain('"Claude · Timeline Tracker"');
  });
});

describe('the AI Kit under a host app\'s brand', () => {
  const cadrel: KitBrand = { id: 'cadrel', name: 'Cadrel', folder: 'Cadrel AI Kit' };
  const k = buildKit({ skills, server, version: '1.2.3', root: 'C:\\Users\\me\\Cadrel Write', serverPath: 'C:\\Users\\me\\Downloads\\Cadrel AI Kit\\cadrel-mcp.js', brand: cadrel });
  const f = (p: string) => k.find((x) => x.path === p)!;

  it('names its files and the Claude Desktop extension after the host, with no Cadrel Write left in their names', () => {
    expect(k.map((x) => x.path)).toContain('cadrel.mcpb');
    expect(k.map((x) => x.path)).toContain('cadrel-mcp.js');
    expect(k.map((x) => x.path)).not.toContain('cadrel-write.mcpb');
    const m = JSON.parse(strFromU8(unzipSync(f('cadrel.mcpb').data)['manifest.json']));
    expect(m).toMatchObject({ name: 'cadrel', display_name: 'Cadrel', author: { name: 'Cadrel' } });
    expect(m.description).toContain('Cadrel chapters');
  });

  it('puts the host\'s name in the settings snippets and the readme', () => {
    const settings = strFromU8(f('connect-settings.txt').data);
    expect(settings).toContain('claude mcp add cadrel --');
    expect(settings).toContain('[mcp_servers.cadrel]');
    expect(settings).toContain('"cadrel": {');
    expect(settings).toContain('cadrel.mcpb');
    expect(strFromU8(f('README.txt').data)).toContain('Cadrel AI Kit'.replace(' AI Kit', ''));
    expect(strFromU8(f('README.txt').data)).not.toContain('Cadrel Write');
  });
});
