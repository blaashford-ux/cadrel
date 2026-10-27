/**
 * When the MCP server must stop, so that it never outlives what started it and never holds the installed app's files open.
 *
 * An AI app starts this server as a child process and talks to it over stdio. It is Cadrel's own program (the installed Cadrel.exe run as Node), so while
 * it runs, Windows will not let an update replace that file. The server therefore stops itself when:
 *  - the connection closes (stdin ends: the AI app quit, or the launcher in between was killed, which closes the pipe but does not stop a child);
 *  - the program that started it is gone (a belt for pipes that stay open because something else inherited them);
 *  - an update is starting: Cadrel, or its installer, writes a marker file next to the program, and a fresh one means "let go now".
 */
import { statSync } from 'node:fs';

export interface LifecycleOptions {
  /** Emits `end` / `close` when the AI app's connection is gone. */
  stdin?: { on(event: 'end' | 'close', listener: () => void): unknown } | null;
  /** The marker an update writes. A marker newer than `markerMaxAgeMs` means stop; an old one is leftover and ignored. */
  retireFile?: string | null;
  /** The process that started this one; when it no longer exists, stop. */
  parentPid?: number | null;
  onStop(reason: string): void;
  pollMs?: number;
  markerMaxAgeMs?: number;
  now?: () => number;
  /** Whether a process exists (tests replace it). */
  alive?: (pid: number) => boolean;
  /** Modified time of a file in ms, or null if it does not exist (tests replace it). */
  mtime?: (file: string) => number | null;
}

const defaultAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'; // it exists, we just may not signal it
  }
};
const defaultMtime = (file: string): number | null => {
  try {
    return statSync(file).mtimeMs;
  } catch {
    return null;
  }
};

/** Starts watching; returns a function that stops the watching (not the server). `onStop` is called at most once. */
export function watchLifecycle(o: LifecycleOptions): () => void {
  let done = false;
  const stop = (reason: string) => {
    if (done) return;
    done = true;
    clear();
    o.onStop(reason);
  };
  o.stdin?.on('end', () => stop('the AI app closed its connection'));
  o.stdin?.on('close', () => stop('the AI app closed its connection'));
  const now = o.now ?? Date.now;
  const alive = o.alive ?? defaultAlive;
  const mtime = o.mtime ?? defaultMtime;
  const poll = () => {
    if (o.retireFile) {
      const m = mtime(o.retireFile);
      if (m !== null && now() - m < (o.markerMaxAgeMs ?? 10 * 60_000)) return stop('Cadrel is being updated');
    }
    if (o.parentPid && o.parentPid > 1 && !alive(o.parentPid)) stop('the program that started it has gone');
  };
  const timer = setInterval(poll, o.pollMs ?? 2000);
  timer.unref(); // watching must never be what keeps the process alive
  const clear = () => clearInterval(timer);
  poll();
  return clear;
}
