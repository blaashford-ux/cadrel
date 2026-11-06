import type { CoreApi } from '@cadrel/write/src/shared/api';
import type { StudioSync } from './vaultSync';

const manage = 'Projects are made and managed in Cadrel on the desktop. Here you can open them and write in them.';
const keep = 'Renaming and deleting files is done in Cadrel on the desktop, where every change is kept in the file’s history.';

/**
 * The editor's calls, as this app allows them. Writing is allowed (and asked of the Studio's rules first: a role that cannot write, or a file
 * someone else holds, is refused in words before anything is typed into it); making, renaming, moving or deleting projects and files is not,
 * because the Studio's vault keeps versions and has no rename or delete. After a change, a sync follows soon.
 */
export function studioGuard(api: CoreApi, sync: Pick<StudioSync, 'assertWritable' | 'syncSoon'>): CoreApi {
  const refuse = (message: string) => () => Promise.reject(new Error(message));
  return {
    ...api,
    writeFile: async (path, content) => {
      sync.assertWritable(path);
      const r = await api.writeFile(path, content);
      sync.syncSoon();
      return r;
    },
    createFile: async (dir, name, content) => {
      sync.assertWritable(dir);
      const r = await api.createFile(dir, name, content);
      sync.syncSoon();
      return r;
    },
    createFolder: async (dir, name) => {
      sync.assertWritable(dir);
      return api.createFolder(dir, name);
    },
    renameNode: refuse(keep),
    trashNode: refuse(keep),
    createProject: refuse(manage),
    renameProject: refuse(manage),
    duplicateProject: refuse(manage),
    deleteProject: refuse(manage),
    convertFolder: refuse(manage),
    addMissingTemplateParts: refuse(manage),
    moveProjects: refuse(manage)
  };
}
