import { describe, expect, it } from 'vitest';
import { buildInviteLink, inviteMessage, LATEST_RELEASE, parseInviteLink } from './link';

const invite = { packageId: '1AbCdEfGhIjKlMn', commentsId: '1ZyXwVuTsRqPoNm', reviewerId: 'a1b2c3d4', project: 'The Lost King & Co' };

describe('invitation links', () => {
  it('round-trips, including awkward project names', () => {
    expect(parseInviteLink(buildInviteLink(invite))).toEqual(invite);
  });

  it('accepts an mdedit: link and surrounding whitespace', () => {
    const q = new URLSearchParams({ p: invite.packageId, c: invite.commentsId, r: invite.reviewerId, n: 'X' });
    expect(parseInviteLink(`  mdedit://join?${q}\n`)?.project).toBe('X');
  });

  it('rejects anything that is not an invitation', () => {
    expect(parseInviteLink('hello')).toBeNull();
    expect(parseInviteLink('https://example.com/#p=a%20b&c=x&r=y')).toBeNull();
    expect(parseInviteLink('https://example.com/')).toBeNull();
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
