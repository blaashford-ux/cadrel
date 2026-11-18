import { describe, expect, it } from 'vitest';
import {
  assistantVisibleFiles, recordAssistantRead,
  ATTACHMENT_LIMIT, ATTACHMENT_MAX_BYTES, UserError, addAttachment, cleanFileName, editAttachment, mimeFor, nameOf, newUser, removeAttachment, sanitizeUser, setAvatar, updateProfile
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

  it('the assistant sees the attached files the person has not hidden, file by file', () => {
    let { user, attachment } = add(newUser(), 'bio.md');
    const b = add(user, 'tax.pdf');
    user = b.user;
    expect(assistantVisibleFiles(user).map((a) => a.name)).toEqual(['bio.md', 'tax.pdf']);
    expect(b.attachment).toMatchObject({ origin: 'user', assistant: true });
    user = editAttachment(user, b.attachment.id, { assistant: false });
    expect(assistantVisibleFiles(user).map((a) => a.name)).toEqual(['bio.md']);
    user = editAttachment(user, attachment.id, { assistant: false });
    expect(assistantVisibleFiles(user)).toEqual([]); // each file is its own choice; there is no master switch
    user = editAttachment(user, b.attachment.id, { assistant: true });
    expect(assistantVisibleFiles(user).map((a) => a.name)).toEqual(['tax.pdf']);
    void attachment;
  });

  it('keeps a bounded log of what the assistant opened', () => {
    let u = newUser();
    for (let i = 0; i < 60; i++) u = recordAssistantRead(u, { at: `2026-01-01T00:00:${String(i).padStart(2, '0')}Z`, fileId: 'a', name: `f${i}`, by: 'Claude' });
    expect(u.assistantReads).toHaveLength(50);
    expect(u.assistantReads[49]!.name).toBe('f59');
  });

  it('defaults for a profile saved before these settings: access on, files not hidden', () => {
    const u = sanitizeUser({ id: 'u', attachments: [{ id: 'a', name: 'x.md' }] });
    expect(u.attachments[0]).toMatchObject({ assistant: true, origin: 'user' });
    expect(sanitizeUser({ attachments: [{ id: 'a', name: 'x.md', assistant: false, origin: 'assistant' }] })).toMatchObject({ attachments: [{ assistant: false, origin: 'assistant' }] });
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

describe('the Patreon link and call to action', () => {
  it('are empty for a new profile and for one saved before they existed', () => {
    const u = newUser('2026-11-17T00:00:00Z', 'u1');
    expect([u.patreonUrl, u.patreonCta]).toEqual(['', '']);
    expect(sanitizeUser({ id: 'u1', displayName: 'Ann' }).patreonUrl).toBe('');
  });
  it('keep a web address (adding https:// when it is left off) and the wording, and can be cleared', () => {
    const u = newUser('2026-11-17T00:00:00Z', 'u1');
    const a = updateProfile(u, { patreonUrl: ' patreon.com/ann ', patreonCta: 'Read ahead.\r\nJoin us.  ' });
    expect(a.patreonUrl).toBe('https://patreon.com/ann');
    expect(a.patreonCta).toBe('Read ahead.\nJoin us.');
    expect(updateProfile(a, { patreonUrl: '' }).patreonUrl).toBe('');
    expect(updateProfile(a, { bio: 'x' }).patreonUrl).toBe('https://patreon.com/ann');
  });
  it('refuse anything that is not a web address', () => {
    const u = newUser('2026-11-17T00:00:00Z', 'u1');
    for (const bad of ['javascript:alert(1)', 'ftp://x.com/a', 'not a link', 'mailto:a@b.com']) expect(() => updateProfile(u, { patreonUrl: bad }), bad).toThrow(UserError);
  });
  it('are read defensively from a hand-edited file', () => {
    expect(sanitizeUser({ patreonUrl: 'javascript:x', patreonCta: 5 }).patreonUrl).toBe('');
    expect(sanitizeUser({ patreonUrl: 'https://www.patreon.com/a', patreonCta: 'hi' })).toMatchObject({ patreonUrl: 'https://www.patreon.com/a', patreonCta: 'hi' });
  });
});
