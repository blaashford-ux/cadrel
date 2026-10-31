import { describe, expect, it } from 'vitest';
import { buildInviteLink, inviteMessage, LATEST_RELEASE, parseInviteLink, readerLink, WRITE_RELEASE } from './link';

const invite = { packageId: '1AbCdEfGhIjKlMn', commentsId: '1ZyXwVuTsRqPoNm', reviewerId: 'a1b2c3d4', project: 'The Lost King & Co' };

describe('invitation links', () => {
  it('round-trips, including awkward project names', () => {
    expect(parseInviteLink(buildInviteLink(invite))).toEqual(invite);
  });

  it('accepts a cadrel-write: link and surrounding whitespace', () => {
    const q = new URLSearchParams({ p: invite.packageId, c: invite.commentsId, r: invite.reviewerId, n: 'X' });
    expect(parseInviteLink(`  cadrel-write://join?${q}\n`)?.project).toBe('X');
  });

  it('accepts a cadrel-reader: link, and turns a web link into one', () => {
    const own = readerLink(buildInviteLink(invite))!;
    expect(own.startsWith('cadrel-reader://join?')).toBe(true);
    expect(parseInviteLink(own)).toEqual(invite);
    expect(readerLink('not a link')).toBeNull();
  });

  it('keeps the editing role through a cadrel-reader: link', () => {
    expect(parseInviteLink(buildInviteLink({ ...invite, role: 'edit' }))?.role).toBe('edit');
  });

  it('rejects anything that is not an invitation', () => {
    expect(parseInviteLink('hello')).toBeNull();
    expect(parseInviteLink('https://example.com/#p=a%20b&c=x&r=y')).toBeNull();
    expect(parseInviteLink('https://example.com/')).toBeNull();
  });

  it('sends a reader to Cadrel Reader and a collaborator to Cadrel', () => {
    const link = buildInviteLink(invite);
    expect(inviteMessage('X', link)).toContain('Cadrel Reader');
    expect(inviteMessage('X', link)).not.toContain(WRITE_RELEASE);
    const edit = inviteMessage('X', buildInviteLink({ ...invite, role: 'edit' }), undefined, 'edit');
    expect(edit).toContain(WRITE_RELEASE);
    expect(edit).not.toContain('Cadrel Reader');
  });

  it('wraps a link in a short note that points at the latest release', () => {
    const link = buildInviteLink(invite);
    const msg = inviteMessage('The Lost King', link, 'Sam');
    expect(msg).toContain(LATEST_RELEASE);
    expect(msg).toContain(link);
    expect(msg.startsWith('Hi Sam,')).toBe(true);
    expect(parseInviteLink(msg)).toEqual(invite); // pasting the whole message works too
    expect(inviteMessage('X', link)).not.toContain('Hi ');
  });
});
