import { describe, expect, it } from 'vitest';
import {
  ATTACHMENT_LIMIT, ATTACHMENT_MAX_BYTES, addAttachment, cleanFileName, editAttachment, mimeFor, nameOf, newUser, removeAttachment, sanitizeUser, setAvatar, updateProfile
} from '../src/user';

const add = (u = newUser(), name = 'Contract.pdf', size = 10) => addAttachment(u, { name, size, hash: 'abc' });

describe('user profile', () => {
  it('starts empty; the name falls back to the computer’s user name', () => {
    const u = newUser();
    expect(u).toMatchObject({ displayName: '', penNames: [], attachments: [], avatarId: null });
    expect(nameOf(u, 'blake')).toBe('blake');
    expect(nameOf(updateProfile(u, { displayName: '  Blake   Ashford ' }), 'x')).toBe('Blake Ashford');
  });

  it('edits the profile, trimming and checking', () => {
    let u = updateProfile(newUser(), { email: 'blake@example.com', penNames: ['Ashe Wilder', ' ashe wilder ', 'Loric Thorne', ''], bio: 'Writes fantasy.\r\nAnd more.' });
    expect(u).toMatchObject({ email: 'blake@example.com', penNames: ['Ashe Wilder', 'Loric Thorne'], bio: 'Writes fantasy.\nAnd more.' });
    expect(() => updateProfile(u, { email: 'not an email' })).toThrow(/email/);
    u = updateProfile(u, { email: '' });
    expect(u.email).toBe('');
    expect(() => updateProfile(u, { penNames: Array.from({ length: 21 }, (_, i) => `n${i}`) })).toThrow(/pen names/);
    expect(updateProfile(u, { bio: 'x'.repeat(5000) }).bio).toHaveLength(2000);
  });

  it('attaches files: name cleaned, type from the extension, note kept', () => {
    const { user, attachment } = addAttachment(newUser(), { name: 'C:\\Users\\b\\Docs\\Signed: contract?.pdf', size: 1234, hash: 'h', note: '  with Acme ' });
    expect(attachment).toMatchObject({ name: 'Signed_ contract_.pdf', size: 1234, mime: 'application/pdf', note: 'with Acme', hash: 'h' });
    expect(user.attachments).toHaveLength(1);
    expect(mimeFor('photo.JPG')).toBe('image/jpeg');
    expect(mimeFor('mystery')).toBe('application/octet-stream');
    expect(cleanFileName('../../etc/passwd')).toBe('passwd');
    expect(cleanFileName('...')).toBe('file');
  });

  it('refuses a file that is too big, and too many files', () => {
    expect(() => add(newUser(), 'big.zip', ATTACHMENT_MAX_BYTES + 1)).toThrow(/larger than/);
    let u = newUser();
    for (let i = 0; i < ATTACHMENT_LIMIT; i++) u = add(u, `f${i}.txt`).user;
    expect(() => add(u, 'one-more.txt')).toThrow(/At most/);
  });

  it('edits an attachment’s note and name, and removes it', () => {
    const { user, attachment } = add();
    let u = editAttachment(user, attachment.id, { note: 'Final', name: 'Contract final.pdf' });
    expect(u.attachments[0]).toMatchObject({ note: 'Final', name: 'Contract final.pdf' });
    expect(() => editAttachment(u, 'nope', {})).toThrow(/no such/);
    u = removeAttachment(u, attachment.id);
    expect(u.attachments).toEqual([]);
  });

  it('the photo must be an attached picture, and goes when its file goes', () => {
    const a = add(newUser(), 'me.png');
    const b = add(a.user, 'notes.pdf');
    expect(() => setAvatar(b.user, b.attachment.id)).toThrow(/picture/);
    expect(() => setAvatar(b.user, 'nope')).toThrow(/no such/);
    const withPhoto = setAvatar(b.user, a.attachment.id);
    expect(withPhoto.avatarId).toBe(a.attachment.id);
    expect(removeAttachment(withPhoto, a.attachment.id).avatarId).toBeNull();
    expect(setAvatar(withPhoto, null).avatarId).toBeNull();
  });

  it('sanitizeUser survives garbage and keeps only what makes sense', () => {
    expect(sanitizeUser(null).attachments).toEqual([]);
    expect(sanitizeUser('x').displayName).toBe('');
    const u = sanitizeUser({
      id: 'u_1', displayName: '  Blake ', email: 'bad', penNames: ['A', 'a', 'B'], avatarId: 'a2',
      attachments: [{ id: 'a1', name: 'doc.pdf', size: 5, hash: 'h' }, { id: 'a1', name: 'dupe.pdf' }, { name: 'no id' }, { id: 'a2', name: 'pic.exe.png', size: -4 }]
    });
    expect(u).toMatchObject({ id: 'u_1', displayName: 'Blake', email: '', penNames: ['A', 'B'], avatarId: 'a2' });
    expect(u.attachments.map((a) => [a.id, a.size, a.mime])).toEqual([['a1', 5, 'application/pdf'], ['a2', 0, 'image/png']]);
    expect(sanitizeUser({ avatarId: 'zzz', attachments: [] }).avatarId).toBeNull();
    expect(sanitizeUser({ avatarId: 'a1', attachments: [{ id: 'a1', name: 'doc.pdf' }] }).avatarId).toBeNull(); // not a picture
  });
});
