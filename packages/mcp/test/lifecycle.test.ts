import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { watchLifecycle } from '../src/lifecycle.js';

afterEach(() => vi.useRealTimers());

describe('when the server stops itself', () => {
  it('stops once, when the connection ends or closes', () => {
    const stdin = new EventEmitter();
    const onStop = vi.fn();
    watchLifecycle({ stdin, onStop });
    stdin.emit('end');
    stdin.emit('close');
    expect(onStop).toHaveBeenCalledTimes(1);
    expect(onStop).toHaveBeenCalledWith('the AI app closed its connection');
  });

  it('stops when the program that started it is gone, not before', () => {
    vi.useFakeTimers();
    let up = true;
    const onStop = vi.fn();
    watchLifecycle({ parentPid: 4242, alive: () => up, onStop, pollMs: 1000 });
    vi.advanceTimersByTime(5000);
    expect(onStop).not.toHaveBeenCalled();
    up = false;
    vi.advanceTimersByTime(1000);
    expect(onStop).toHaveBeenCalledWith('the program that started it has gone');
    vi.advanceTimersByTime(5000);
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it('does not watch a parent that is not a real process id', () => {
    vi.useFakeTimers();
    const onStop = vi.fn();
    watchLifecycle({ parentPid: 0, alive: () => false, onStop, pollMs: 1000 });
    watchLifecycle({ parentPid: 1, alive: () => false, onStop, pollMs: 1000 });
    vi.advanceTimersByTime(5000);
    expect(onStop).not.toHaveBeenCalled();
  });

  it('stops for a fresh update marker, ignores an old one and a missing one', () => {
    vi.useFakeTimers({ now: 1_000_000_000 });
    let m: number | null = null;
    const onStop = vi.fn();
    watchLifecycle({ retireFile: 'x', mtime: () => m, onStop, pollMs: 1000, markerMaxAgeMs: 600_000 });
    vi.advanceTimersByTime(3000);
    expect(onStop).not.toHaveBeenCalled(); // no marker
    m = Date.now() - 3_600_000; // an hour old: left over from an earlier update
    vi.advanceTimersByTime(3000);
    expect(onStop).not.toHaveBeenCalled();
    m = Date.now(); // just written
    vi.advanceTimersByTime(1000);
    expect(onStop).toHaveBeenCalledWith('Cadrel is being updated');
  });

  it('stops at once when a fresh marker is already there at start (a restarted server during an update)', () => {
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cadrel-retire-')), '.cadrel-retire');
    fs.writeFileSync(f, '');
    const onStop = vi.fn();
    watchLifecycle({ retireFile: f, onStop });
    expect(onStop).toHaveBeenCalledWith('Cadrel is being updated');
  });

  it('can be cancelled, and never keeps the process alive by itself', () => {
    vi.useFakeTimers();
    const onStop = vi.fn();
    const cancel = watchLifecycle({ parentPid: 4242, alive: () => false, onStop, pollMs: 1000 });
    expect(onStop).toHaveBeenCalledTimes(1); // first poll runs at once
    cancel();
    expect(vi.getTimerCount()).toBe(0);
  });
});
