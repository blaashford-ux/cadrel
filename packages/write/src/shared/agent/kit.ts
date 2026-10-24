import { strToU8, zipSync } from 'fflate';
import { aiConfigSnippets } from './config';

/** The folder the AI Kit is written into (inside the user's Downloads). */
export const KIT_FOLDER = 'MDEdit AI Kit';

export interface KitSkill {
  /** Folder name, e.g. "mdedit-line-edit". */
  name: string;
  /** Prompt id, e.g. "line_edit". */
  id: string;
  /** What notes are signed with, e.g. "Line edit". */
  tag: string;
  /** The whole SKILL.md, front matter included. */
  markdown: string;
  /** The instructions without front matter. */
  body: string;
}

export interface KitInput {
  skills: KitSkill[];
  /** The bundled MCP server (`mdedit-mcp.js`). */
  server: Uint8Array;
  version: string;
  /** The Root Folder, offered as the default projects folder. */
  root: string;
  /** Where `mdedit-mcp.js` will be once written (for the settings snippets that point at it). */
  serverPath: string;
}

export interface KitFile {
  /** Path inside the kit folder, "/" separated. */
  path: string;
  data: Uint8Array;
}

const text = (path: string, content: string): KitFile => ({ path, data: strToU8(content) });

/** A Claude Desktop extension: Claude Desktop runs the server with its own Node, so the user installs nothing else. */
function extension(i: KitInput): Uint8Array {
  const manifest = {
    manifest_version: '0.2',
    name: 'mdedit',
    display_name: 'MDEdit',
    version: i.version,
    description: 'Lets Claude read your MDEdit chapters and leave comments and suggestions in your Notes panel. It never changes your manuscript.',
    author: { name: 'MDEdit' },
    server: {
      type: 'node',
      entry_point: 'server/index.js',
      mcp_config: { command: 'node', args: ['${__dirname}/server/index.js', '--root', '${user_config.root_folder}'] },
    },
    user_config: {
      root_folder: {
        type: 'directory',
        title: 'Projects folder',
        description: 'Leave this empty to follow the Root Folder set in MDEdit (File → Settings → Projects). Set it only if your books live somewhere else; it must be the folder that holds your book folders, not one book\'s folder.',
        required: false,
      },
    },
    compatibility: { platforms: ['win32', 'darwin', 'linux'] },
  };
  return zipSync({ 'manifest.json': strToU8(JSON.stringify(manifest, null, 2)), 'server/index.js': i.server });
}

/** One skill as a zip with the skill's folder at the top, the shape Claude's skill upload expects. */
const skillZip = (s: KitSkill): Uint8Array => zipSync({ [`${s.name}/SKILL.md`]: strToU8(s.markdown) });

function readme(i: KitInput): string {
  const lines = [
    'MDEDIT AI KIT',
    '=============',
    '',
    'Everything here lets an AI app review your chapters and leave comments and suggestions in MDEdit\'s Notes panel.',
    'The AI cannot change your manuscript. You accept or reject each note. New notes appear in the Notes panel within a few seconds.',
    '',
    'CLAUDE DESKTOP (the easiest)',
    '  1. Double-click mdedit.mcpb, or drag it into Claude Desktop under Settings > Extensions. Install it, and check the',
    `     projects folder it asks for is empty or is: ${i.root} (the folder that holds your book folders, not one book's folder).`,
    '     Empty is best: it follows the Root Folder you set in MDEdit.',
    '  2. Add the skills: Settings > Capabilities > Skills > upload each zip in the "skills" folder (three of them).',
    '  3. Start a chat and ask: "Do a line edit of the chapters in my project <name>."',
    '',
    'CLAUDE CODE',
    '  1. Copy the three folders inside skills\\folders into your skills folder (~/.claude/skills).',
    '  2. Add the server: open connect-settings.txt and run the "Claude Code" command. It needs Node.js 20 or newer.',
    '',
    'GPT (Codex CLI, the OpenAI Agents SDK and other apps that can run an MCP server)',
    '  1. Add the server with the Codex settings in connect-settings.txt (needs Node.js 20 or newer).',
    '  2. In those apps the three editing passes are available as prompts named developmental_edit, line_edit and copy_edit.',
    '  3. For anything else, paste one of the files in the "for-gpt" folder into your custom instructions.',
    '  The ChatGPT app and claude.ai on the web cannot reach a program on your PC, so they cannot use the server.',
    '',
    'THE THREE EDITING PASSES',
    ...i.skills.map((s) => `  ${s.tag}: notes are signed "Claude · ${s.tag}" (or "GPT · ${s.tag}")`),
    '',
    'If you move your MDEdit Root Folder, update the projects folder in the settings you added.',
    'These files are made by MDEdit (version ' + i.version + '). Choose Notes > AI... in MDEdit to save them again after an update.',
    '',
  ];
  return lines.join('\r\n');
}

function settings(i: KitInput): string {
  const s = aiConfigSnippets({ root: i.root, command: 'node', args: [i.serverPath, '--root', i.root] });
  return [
    'These run the server file saved next to this one. They need Node.js 20 or newer.',
    '(For Claude Desktop, use mdedit.mcpb instead: it needs no Node.js.)',
    '',
    '--- Claude Code: run this in a terminal ---',
    s.claudeCode,
    '',
    '--- Codex (GPT): add this to ~/.codex/config.toml ---',
    s.codex,
    '',
    '--- Any other app that takes MCP settings as JSON ---',
    s.claudeDesktop,
    '',
  ].join('\r\n');
}

/** The files of the AI Kit. Pure: the app writes them into Downloads. */
export function buildKit(i: KitInput): KitFile[] {
  return [
    text('README.txt', readme(i)),
    { path: 'mdedit.mcpb', data: extension(i) },
    { path: 'mdedit-mcp.js', data: i.server },
    text('connect-settings.txt', settings(i)),
    ...i.skills.flatMap((s) => [
      { path: `skills/${s.name}.zip`, data: skillZip(s) },
      text(`skills/folders/${s.name}/SKILL.md`, s.markdown),
      text(`for-gpt/${s.name}.md`, `${s.body}\n\nWhen you call add_notes, set skill to "${s.tag}".\n`),
    ]),
  ];
}
