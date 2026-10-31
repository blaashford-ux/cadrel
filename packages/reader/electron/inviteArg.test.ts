import { describe, expect, it } from 'vitest';
import { parseInviteLink } from '@cadrel/write/src/shared/review/link';
import { inviteFromArgv } from './inviteArg';

describe('an invitation link on the command line', () => {
  const link = 'cadrel-reader://join?v=1&p=pkgFILE123&c=cmtFILE456&r=rev12345&n=Book';

  it('is found among the flags, with or without quotes', () => {
    expect(inviteFromArgv(['--allow-file-access', link])).toBe(link);
    expect(inviteFromArgv([`"${link}"`])).toBe(link);
    expect(parseInviteLink(inviteFromArgv([link])!)?.project).toBe('Book');
  });

  it('ignores anything that is not a cadrel-reader link', () => {
    expect(inviteFromArgv(['C:\\Users\\me\\book.md', 'https://example.com/#p=a&c=b&r=c', 'cadrel-write://join?x=1', '--flag'])).toBeNull();
    expect(inviteFromArgv([])).toBeNull();
  });
});
