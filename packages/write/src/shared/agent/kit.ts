import { strToU8, zipSync } from 'fflate';
import { aiConfigSnippets } from './config';

/** The folder the AI Kit is written into (inside the user's Downloads). */
export const KIT_FOLDER = 'Cadrel Write AI Kit';

/** What the kit calls itself. A host app that bundles Cadrel Write (Cadrel) passes its own, so there is one extension, not two. */
export interface KitBrand {
  /** Lower-case id used in file names and as the MCP server's name in settings: "cadrel-write", "cadrel". */
  id: string;
  /** Display name: "Cadrel Write", "Cadrel". */
  name: string;
  /** Folder inside Downloads. */
  folder: string;
  /** What the Claude Desktop extension says it does. Default: the writing description. */
  description?: string;
}
export const WRITE_BRAND: KitBrand = { id: 'cadrel-write', name: 'Cadrel Write', folder: KIT_FOLDER };

/** Re-words text written for Cadrel Write for another brand. A no-op for Cadrel Write itself. */
const rebrand = (t: string, b: KitBrand): string => (b.id === 'cadrel-write' ? t : t.replaceAll('Cadrel Write', b.name).replaceAll('cadrel-write', b.id));

export interface KitSkill {
  /** Folder name, e.g. "cadrel-line-edit". */
  name: string;
  /** Prompt id, e.g. "line_edit". */
  id: string;
  /** What notes are signed with, e.g. "Line edit" (a review skill), or the skill's title (an authoring skill). */
  tag: string;
  /** A review skill leaves notes on the manuscript; an authoring skill makes files in the project. Default: review. */
  kind?: 'review' | 'author';
  /** Other files the skill carries (HTML templates), by path inside its folder. */
  files?: Record<string, string>;
  /** The whole SKILL.md, front matter included. */
  markdown: string;
  /** The instructions without front matter. */
  body: string;
}

export interface KitInput {
  skills: KitSkill[];
  /** The bundled MCP server (`cadrel-write-mcp.js`). */
  server: Uint8Array;
  version: string;
  /** The Root Folder, offered as the default projects folder. */
  root: string;
  /** Where `<id>-mcp.js` will be once written (for the settings snippets that point at it). */
  serverPath: string;
  /** Default: Cadrel Write. */
  brand?: KitBrand;
  /** More arguments for the server in the settings snippets (a host pins the server to one Studio's data). */
  extraArgs?: string[];
}

export interface KitFile {
  /** Path inside the kit folder, "/" separated. */
  path: string;
  data: Uint8Array;
}

const text = (path: string, content: string): KitFile => ({ path, data: strToU8(content) });

/** A Claude Desktop extension: Claude Desktop runs the server with its own Node, so the user installs nothing else. */
function extension(i: KitInput, b: KitBrand): Uint8Array {
  const manifest = {
    manifest_version: '0.2',
    name: b.id,
    display_name: b.name,
    version: i.version,
    description: b.description ?? rebrand('Lets Claude read your Cadrel Write chapters and leave comments and suggestions in your Notes panel. It only creates or edits files if you allow it in Cadrel’s Settings → MCP.', b),
    author: { name: b.name },
    server: {
      type: 'node',
      entry_point: 'server/index.js',
      mcp_config: { command: 'node', args: ['${__dirname}/server/index.js', '--root', '${user_config.root_folder}'] },
    },
    user_config: {
      root_folder: {
        type: 'directory',
        title: 'Projects folder',
        description: rebrand('Leave this empty to follow the Root Folder set in Cadrel Write (File → Settings → Projects). Set it only if your books live somewhere else; it must be the folder that holds your book folders, not one book\'s folder.', b),
        required: false,
      },
    },
    compatibility: { platforms: ['win32', 'darwin', 'linux'] },
  };
  return zipSync({ 'manifest.json': strToU8(JSON.stringify(manifest, null, 2)), 'server/index.js': i.server });
}

/** One skill as a zip with the skill's folder at the top, the shape Claude's skill upload expects. */
const skillZip = (s: KitSkill): Uint8Array =>
  zipSync({ [`${s.name}/SKILL.md`]: strToU8(s.markdown), ...Object.fromEntries(Object.entries(s.files ?? {}).map(([p, c]) => [`${s.name}/${p}`, strToU8(c)])) });
const isReview = (s: KitSkill) => (s.kind ?? 'review') === 'review';

function readme(i: KitInput): string {
  const review = i.skills.filter(isReview);
  const author = i.skills.filter((s) => !isReview(s));
  const n = (list: KitSkill[]) => ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'][list.length] ?? String(list.length);
  const lines = [
    'CADREL WRITE AI KIT',
    '=============',
    '',
    'Everything here lets an AI app review your chapters and leave comments and suggestions in Cadrel Write\'s Notes panel.',
    'The AI cannot change your manuscript. You accept or reject each note. New notes appear in the Notes panel within a few seconds.',
    '',
    'CLAUDE DESKTOP (the easiest)',
    '  1. Double-click cadrel-write.mcpb, or drag it into Claude Desktop under Settings > Extensions. Install it, and check the',
    `     projects folder it asks for is empty or is: ${i.root} (the folder that holds your book folders, not one book's folder).`,
    '     Empty is best: it follows the Root Folder you set in Cadrel Write.',
    '  2. Add the skills: Settings > Capabilities > Skills > upload each zip in the "skills" folder (' + n(i.skills) + ' of them).',,
    '  3. Start a chat and ask: "Do a line edit of the chapters in my project <name>."',
    '',
    'CLAUDE CODE',
    '  1. Copy the folders inside skills\\folders into your skills folder (~/.claude/skills).',
    '  2. Add the server: open connect-settings.txt and run the "Claude Code" command. It needs Node.js 20 or newer.',
    '',
    'GPT (Codex CLI, the OpenAI Agents SDK and other apps that can run an MCP server)',
    '  1. Add the server with the Codex settings in connect-settings.txt (needs Node.js 20 or newer).',
    `  2. In those apps the skills are available as prompts: ${i.skills.map((s) => s.id).join(', ')}.`,
    '  3. For anything else, paste one of the files in the "for-gpt" folder into your custom instructions.',
    '  The ChatGPT app and claude.ai on the web cannot reach a program on your PC, so they cannot use the server.',
    '',
    `THE ${n(review).toUpperCase()} EDITING PASS${review.length === 1 ? '' : 'ES'}`,
    ...review.map((s) => `  ${s.tag}: notes are signed "Claude · ${s.tag}" (or "GPT · ${s.tag}")`),
    ...(author.length
      ? [
          '',
          `THE ${n(author).toUpperCase()} AUTHORING SKILL${author.length === 1 ? '' : 'S'}`,
          '  These make files in your project (never in the manuscript): a premise, characters, an outline, a blurb, keywords, and trackers with',
          '  pages you can open in a browser. They never overwrite a file without asking, and keep the version they replace.',
          ...author.map((s) => `  ${s.tag}`),
        ]
      : []),
    '',
    'If you move your Cadrel Write Root Folder, update the projects folder in the settings you added.',
    'These files are made by Cadrel Write (version ' + i.version + '). Choose Notes > AI... in Cadrel Write to save them again after an update.',
    '',
  ];
  return lines.join('\r\n');
}

function settings(i: KitInput, b: KitBrand): string {
  const s = aiConfigSnippets({ root: i.root, command: 'node', args: [i.serverPath, '--root', i.root, ...(i.extraArgs ?? [])] }, b.id);
  return [
    'These run the server file saved next to this one. They need Node.js 20 or newer.',
    '(For Claude Desktop, use cadrel-write.mcpb instead: it needs no Node.js.)',
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
  const b = i.brand ?? WRITE_BRAND;
  return [
    text('README.txt', rebrand(readme(i), b)),
    { path: `${b.id}.mcpb`, data: extension(i, b) },
    { path: `${b.id}-mcp.js`, data: i.server },
    text('connect-settings.txt', rebrand(settings(i, b), b)),
    ...i.skills.flatMap((s) => [
      { path: `skills/${s.name}.zip`, data: skillZip(s) },
      text(`skills/folders/${s.name}/SKILL.md`, s.markdown),
      ...Object.entries(s.files ?? {}).map(([p, c]) => text(`skills/folders/${s.name}/${p}`, c)),
      text(`for-gpt/${s.name}.md`, isReview(s) ? `${s.body}\n\nWhen you call add_notes, set skill to "${s.tag}".\n` : `${s.body}\n`),
    ]),
  ];
}
