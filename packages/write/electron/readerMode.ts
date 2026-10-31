/**
 * Cadrel Reader runs this module with `reader: true`. The window can only show what Reader's capabilities allow, but the module
 * does not rely on that: every channel that writes, shares, exports or connects an AI is taken away here, so a page that tried to
 * call one would get "No handler registered" and nothing would happen. See `createWriteModule`.
 */
export const READER_BLOCKED_CHANNELS: readonly string[] = [
  // AI apps (the MCP server and its kit)
  'ai:server', 'ai:exportKit', 'ai:remote:get', 'ai:remote:set', 'ai:remote:reset',
  // changing files: a shared project is read-only here, notes travel in the review file (`review:save`)
  'fs:writeFile', 'fs:createFile', 'fs:createFolder', 'fs:renameNode', 'fs:trashNode', 'fs:importDocx',
  // export and its fonts
  'export:getDetails', 'export:saveDetails', 'export:setMarked', 'export:relink', 'export:plan', 'export:run', 'export:open', 'export:pickCover', 'report:save',
  'fonts:installed', 'fonts:preview',
  // making and managing the person's own projects
  'projects:create', 'projects:update', 'projects:rename', 'projects:duplicate', 'projects:delete', 'projects:convert', 'projects:addMissing', 'projects:move',
  // being the author: sharing a project, inviting people, stopping
  'review:shareStatus', 'review:invite', 'review:shareChapters', 'review:revoke', 'review:listShares', 'review:stop',
  // choosing any folder on the computer
  'dialog:pickFolder'
];
