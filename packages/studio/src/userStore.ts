/**
 * The user's profile and the files attached to it, on this computer: `user.json` and an `attachments` folder beside it.
 * Each attached file is copied in (the original is never touched or moved) and is kept under its own id, so two files with
 * the same name cannot collide and a name in the profile can change without touching the disk.
 */
import { createHash } from 'node:crypto';
import { createReadStream, promises as fsp } from 'node:fs';
import path from 'node:path';
import {
  addAttachment, editAttachment, removeAttachment, sanitizeUser, setAvatar, updateProfile, UserError, newUser, ATTACHMENT_MAX_BYTES,
  type Attachment, type ProfilePatch, type UserProfile
} from '@cadrel/kernel';

async function hashFile(file: string): Promise<string> {
  const h = createHash('sha256');
  for await (const chunk of createReadStream(file)) h.update(chunk as Buffer);
  return h.digest('hex');
}

export class UserStore {
  private queue: Promise<unknown> = Promise.resolve();

  /** `dir` holds user.json and attachments/. */
  constructor(readonly dir: string) {}

  private get file() {
    return path.join(this.dir, 'user.json');
  }
  private blob(id: string) {
    return path.join(this.dir, 'attachments', id);
  }

  async read(): Promise<UserProfile> {
    try {
      return sanitizeUser(JSON.parse(await fsp.readFile(this.file, 'utf8')));
    } catch {
      return newUser();
    }
  }

  private change<T>(fn: (u: UserProfile) => Promise<{ user: UserProfile; result: T }> | { user: UserProfile; result: T }): Promise<T> {
    const run = async () => {
      const { user, result } = await fn(await this.read());
      await fsp.mkdir(this.dir, { recursive: true });
      const tmp = `${this.file}.${process.pid}.${Date.now()}.tmp`;
      await fsp.writeFile(tmp, JSON.stringify(user, null, 2));
      await fsp.rename(tmp, this.file);
      return result;
    };
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }

  /** The profile exists on disk from the first read that changes it; reading never creates files. */
  update(patch: ProfilePatch): Promise<UserProfile> {
    return this.change((u) => {
      const user = updateProfile(u, patch);
      return { user, result: user };
    });
  }

  /** Copies `source` in as an attachment. Fails (and leaves nothing behind) if it is not a readable file or is too big. */
  attach(source: string, note?: string): Promise<Attachment> {
    return this.change(async (u) => {
      const st = await fsp.stat(source).catch(() => null);
      if (!st?.isFile()) throw new UserError(`"${path.basename(source)}" is not a file that can be attached.`);
      if (st.size > ATTACHMENT_MAX_BYTES) throw new UserError(`"${path.basename(source)}" is larger than ${Math.round(ATTACHMENT_MAX_BYTES / 1024 / 1024)} MB.`);
      const staged = path.join(this.dir, 'attachments', `.incoming-${process.pid}-${Date.now()}`);
      await fsp.mkdir(path.dirname(staged), { recursive: true });
      try {
        await fsp.copyFile(source, staged);
        const { user, attachment } = addAttachment(u, { name: path.basename(source), size: (await fsp.stat(staged)).size, hash: await hashFile(staged), note });
        await fsp.rename(staged, this.blob(attachment.id));
        return { user, result: attachment };
      } catch (e) {
        await fsp.rm(staged, { force: true });
        throw e;
      }
    });
  }

  editAttachment(id: string, patch: { note?: string; name?: string }): Promise<void> {
    return this.change((u) => ({ user: editAttachment(u, id, patch), result: undefined }));
  }

  removeAttachment(id: string): Promise<void> {
    return this.change(async (u) => {
      const user = removeAttachment(u, id);
      await fsp.rm(this.blob(id), { force: true });
      return { user, result: undefined };
    });
  }

  setAvatar(id: string | null): Promise<UserProfile> {
    return this.change((u) => {
      const user = setAvatar(u, id);
      return { user, result: user };
    });
  }

  /** Where an attachment's content is on disk (for Open and Show in folder). Null if it is not one of this user's. */
  async pathOf(id: string): Promise<string | null> {
    const u = await this.read();
    if (!u.attachments.some((a) => a.id === id)) return null;
    const p = this.blob(id);
    return (await fsp.stat(p).then((s) => s.isFile(), () => false)) ? p : null;
  }

  /** Checks every attachment's file is there and unchanged; returns the ones that are not. */
  async verify(): Promise<{ id: string; name: string; problem: 'missing' | 'changed' }[]> {
    const bad: { id: string; name: string; problem: 'missing' | 'changed' }[] = [];
    for (const a of (await this.read()).attachments) {
      const p = this.blob(a.id);
      if (!(await fsp.stat(p).then((s) => s.isFile(), () => false))) {
        bad.push({ id: a.id, name: a.name, problem: 'missing' });
        continue;
      }
      if (!a.hash) continue;
      if ((await hashFile(p)) !== a.hash) bad.push({ id: a.id, name: a.name, problem: 'changed' });
    }
    return bad;
  }
}
