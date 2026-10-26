import { describe, expect, it } from 'vitest';
import { findPortHolder, parseLsof, parseNetstat, parseTasklist, stopPortHolder } from '../src/main/portHolder';

const NETSTAT = `
Active Connections

  Proto  Local Address          Foreign Address        State           PID
  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1032
  TCP    127.0.0.1:47321        0.0.0.0:0              LISTENING       8844
  TCP    127.0.0.1:47321        127.0.0.1:50211        ESTABLISHED     8844
  TCP    127.0.0.1:50211        127.0.0.1:47321        ESTABLISHED     5120
  TCP    127.0.0.1:147321       0.0.0.0:0              LISTENING       999
`;

describe('port holder lookup', () => {
  it('reads the listening pid from netstat, ignoring other states, other ports and longer port numbers', () => {
    expect(parseNetstat(NETSTAT, 47321)).toBe(8844);
    expect(parseNetstat(NETSTAT, 9999)).toBeNull();
  });

  it('reads the process name from tasklist and the pid and command from lsof', () => {
    expect(parseTasklist('"BookScout.exe","8844","Console","1","85,000 K"\r\n')).toBe('BookScout.exe');
    expect(parseTasklist('INFO: No tasks are running which match the specified criteria.')).toBeNull();
    expect(parseLsof('p4242\ncBookScout\n')).toEqual({ pid: 4242, name: 'BookScout' });
    expect(parseLsof('')).toBeNull();
  });

  it('puts the two Windows lookups together, and says so when the name is unknown', async () => {
    const exec = async (cmd: string) => (cmd === 'netstat' ? NETSTAT : '"BookScout.exe","8844","Console","1","1 K"');
    expect(await findPortHolder(47321, exec, 'win32')).toEqual({ pid: 8844, name: 'BookScout.exe' });
    expect(await findPortHolder(47321, async (cmd) => (cmd === 'netstat' ? NETSTAT : ''), 'win32')).toEqual({ pid: 8844, name: 'an unknown program' });
  });

  it('never stops this process', async () => {
    await expect(stopPortHolder(process.pid, 47321)).rejects.toThrow(/refusing/);
    await expect(stopPortHolder(0, 47321)).rejects.toThrow(/refusing/);
  });
});
