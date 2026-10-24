import { makeProjects } from '../src/shared/backend/projects';
import { nodeFs } from './nodeFs';

export type { Deps } from '../src/shared/backend/projects';

export const {
  isProject, readMeta, writeMeta, updateMeta, countProject, listProjects, readProgress, recordProgress, createProject, renameProject,
  duplicateProject, deleteProject, convertToProject, addMissingTemplateParts, moveProjects
} = makeProjects(nodeFs);
