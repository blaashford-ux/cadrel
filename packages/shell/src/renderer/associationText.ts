import { getProject, viewLevel, type ProjectTree } from '@cadrel/kernel';

/** Where an association applies, as the person reads it. */
export const appliesTo = (tree: ProjectTree, projectId: string, shownOn: string): string => {
  if (projectId === shownOn) return viewLevel(tree, projectId) === 'book' ? 'this book' : 'the whole project';
  return getProject(tree, projectId)?.name ?? '';
};
