import { strFromU8, unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { buildKit, KIT_FOLDER, type KitFile, type KitSkill } from './kit';

const skills: KitSkill[] = [
  { name: 'mdedit-line-edit', id: 'line_edit', tag: 'Line edit', markdown: '---\nname: mdedit-line-edit\ndescription: "x"\n---\n\n# Line Edit\n', body: '# Line Edit' },
  { name: 'mdedit-copy-edit', id: 'copy_edit', tag: 'Copy edit', markdown: '---\nname: mdedit-copy-edit\ndescription: "y"\n---\n\n# Copy Edit\n', body: '# Copy Edit' },
];
const server = new TextEncoder().encode('console.log("server")');
const kit = buildKit({ skills, server, version: '0.6.0', root: 'C:\\Users\\me\\MDEdit', serverPath: 'C:\\Users\\me\\Downloads\\MDEdit AI Kit\\mdedit-mcp.js' });
const file = (p: string): KitFile => kit.find((f) => f.path === p)!;

describe('the AI Kit', () => {
  it('lists every file, all with safe relative paths', () => {
    expect(kit.map((f) => f.path).sort()).toEqual([
      'README.txt',
      'connect-settings.txt',
      'for-gpt/mdedit-copy-edit.md',
      'for-gpt/mdedit-line-edit.md',
      'mdedit-mcp.js',
      'mdedit.mcpb',
      'skills/folders/mdedit-copy-edit/SKILL.md',
      'skills/folders/mdedit-line-edit/SKILL.md',
      'skills/mdedit-copy-edit.zip',
      'skills/mdedit-line-edit.zip',
    ]);
    for (const f of kit) expect(f.path).not.toMatch(/^\/|\.\.|\\|:/);
    expect(KIT_FOLDER).toBe('MDEdit AI Kit');
  });

  it('makes a Claude Desktop extension that runs the server on the chosen projects folder', () => {
    const files = unzipSync(file('mdedit.mcpb').data);
    expect(Object.keys(files).sort()).toEqual(['manifest.json', 'server/index.js']);
    expect(strFromU8(files['server/index.js'])).toBe('console.log("server")');
    const m = JSON.parse(strFromU8(files['manifest.json']));
    expect(m).toMatchObject({ manifest_version: '0.2', name: 'mdedit', version: '0.6.0', server: { type: 'node', entry_point: 'server/index.js' } });
    expect(m.server.mcp_config.args).toEqual(['${__dirname}/server/index.js', '--root', '${user_config.root_folder}']);
    expect(m.user_config.root_folder).toMatchObject({ type: 'directory', required: false });
  });

  it('zips each skill with its folder at the top, ready to upload', () => {
    const files = unzipSync(file('skills/mdedit-line-edit.zip').data);
    expect(Object.keys(files)).toEqual(['mdedit-line-edit/SKILL.md']);
    expect(strFromU8(files['mdedit-line-edit/SKILL.md'])).toBe(skills[0].markdown);
  });

  it('gives GPT the instructions with the tag to sign with', () => {
    expect(strFromU8(file('for-gpt/mdedit-line-edit.md').data)).toBe('# Line Edit\n\nWhen you call add_notes, set skill to "Line edit".\n');
  });

  it('writes settings that point at the saved server, and a README that names the steps', () => {
    const s = strFromU8(file('connect-settings.txt').data);
    expect(s).toContain('claude mcp add mdedit -- node "C:\\Users\\me\\Downloads\\MDEdit AI Kit\\mdedit-mcp.js" --root C:\\Users\\me\\MDEdit');
    expect(s).toContain("[mcp_servers.mdedit]");
    const r = strFromU8(file('README.txt').data);
    for (const needle of ['mdedit.mcpb', 'Settings > Capabilities > Skills', 'C:\\Users\\me\\MDEdit', 'Line edit', 'Copy edit', 'developmental_edit']) expect(r).toContain(needle);
    expect(file('mdedit-mcp.js').data).toBe(server);
  });
});
