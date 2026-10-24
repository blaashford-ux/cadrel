import fs from 'node:fs';
import path from 'node:path';
import util from 'node:util';

const MAX_BYTES = 2 * 1024 * 1024;
const KEEP = 3;

/** A small rotating log file: <name>.log, <name>.1.log, ... Written synchronously so crashes are not lost. */
export class Logger {
  readonly file: string;

  constructor(private readonly dir: string, private readonly name = 'bookscout') {
    fs.mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, `${name}.log`);
  }

  private rotate(): void {
    try {
      if (fs.statSync(this.file).size < MAX_BYTES) return;
    } catch {
      return;
    }
    for (let i = KEEP - 1; i >= 1; i--) {
      const from = path.join(this.dir, `${this.name}.${i}.log`);
      if (fs.existsSync(from)) fs.renameSync(from, path.join(this.dir, `${this.name}.${i + 1}.log`));
    }
    fs.renameSync(this.file, path.join(this.dir, `${this.name}.1.log`));
    fs.rmSync(path.join(this.dir, `${this.name}.${KEEP}.log`), { force: true });
  }

  write(level: 'info' | 'warn' | 'error', ...args: unknown[]): void {
    try {
      this.rotate();
      const line = `${new Date().toISOString()} ${level.toUpperCase()} ${util.format(...args.map((a) => (a instanceof Error ? a.stack ?? a.message : a)))}\n`;
      fs.appendFileSync(this.file, line);
    } catch {
      /* logging must never break the app */
    }
  }

  info(...a: unknown[]) { this.write('info', ...a); }
  warn(...a: unknown[]) { this.write('warn', ...a); }
  error(...a: unknown[]) { this.write('error', ...a); }
}
