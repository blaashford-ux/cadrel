import type { FsPort } from '../fsPort';
import { mergeReviewFiles, parseReviewFile, serializeReviewFile } from '../review/comments';

/** Where a project keeps the review files of everyone who has commented on it: one JSON file per reviewer. */
export const REVIEW_DIR = '.mdedit/review';

const safeId = (id: string) => id.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);

export function makeReviews(fs: FsPort) {
  const dirOf = (project: string) => `${project.replace(/[\\/]+$/, '')}/${REVIEW_DIR}`;

  return {
    /** Every review file in the project (unreadable ones are skipped; the app validates the content). */
    async list(project: string): Promise<{ id: string; text: string }[]> {
      const dir = dirOf(project);
      let names: string[];
      try {
        names = (await fs.readdir(dir)).filter((e) => e.isFile && /\.json$/i.test(e.name)).map((e) => e.name);
      } catch {
        return [];
      }
      const out: { id: string; text: string }[] = [];
      for (const name of names.sort()) {
        try {
          out.push({ id: name.replace(/\.json$/i, ''), text: await fs.readText(`${dir}/${name}`) });
        } catch {
          /* deleted between listing and reading */
        }
      }
      return out;
    },

    /** Deletes one reviewer's file. A missing file is fine. */
    async remove(project: string, id: string): Promise<void> {
      const clean = safeId(id);
      if (!clean) throw new Error('A review file needs a reviewer id');
      await fs.rm(`${dirOf(project)}/${clean}.json`, { force: true });
    },

    /**
     * Writes one reviewer's file (via a temp file, so a crash can't leave half a file). Someone else may have added
     * notes to the same file since the caller read it (an AI reviewer, or the other side of a share), so a valid file is
     * merged with what is on disk instead of replacing it.
     */
    async save(project: string, id: string, text: string): Promise<void> {
      const clean = safeId(id);
      if (!clean) throw new Error('A review file needs a reviewer id');
      const dir = dirOf(project);
      await fs.mkdir(dir, { recursive: true });
      const target = `${dir}/${clean}.json`;
      const incoming = parseReviewFile(text);
      if (incoming) {
        const onDisk = parseReviewFile(await fs.readText(target).catch(() => ''));
        if (onDisk) text = serializeReviewFile(mergeReviewFiles(onDisk, incoming));
      }
      const tmp = `${target}.${Math.floor(Math.random() * 1e9)}.tmp`;
      try {
        await fs.writeText(tmp, text);
        await fs.rename(tmp, target);
      } catch (e) {
        await fs.rm(tmp, { force: true }).catch(() => undefined);
        throw e;
      }
    },
  };
}
