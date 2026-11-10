import { describe, expect, it } from 'vitest';
import { parseInvitation } from '@cadrel/kernel';
import { inviteFromArgv } from './inviteArg';

describe('an invitation link on the command line', () => {
  const link = 'cadrel-reader://join?s=https%3A%2F%2Fstudio.example&c=abcdefghijklmnop&f=ABCD-ABCD-ABCD-ABCD&n=Acme';

  it('is found among the flags, with or without quotes', () => {
    expect(inviteFromArgv(['--allow-file-access', link])).toBe(link);
    expect(inviteFromArgv([`"${link}"`])).toBe(link);
    expect(parseInvitation(inviteFromArgv([link])!)?.studioName).toBe('Acme');
  });

  it('ignores anything that is not a cadrel-reader link', () => {
    expect(inviteFromArgv(['C:\\Users\\me\\book.md', 'https://example.com/#p=a&c=b&r=c', 'cadrel-write://join?x=1', '--flag'])).toBeNull();
    expect(inviteFromArgv([])).toBeNull();
  });
});
