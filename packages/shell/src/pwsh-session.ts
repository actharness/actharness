import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const HOST_SCRIPT = fileURLToPath(new URL('./pwsh-host.ps1', import.meta.url));

export interface PwshRunOpts {
  scriptPath: string;
  stdoutPath: string;
  stderrPath: string;
  cwd: string;
  env: Record<string, string>;
  coverage: boolean;
  timeout?: number | undefined;
}

export interface PwshRunResult {
  exitCode: number;
  timedOut: boolean;
  coverage: Record<string, number>;
  addTypeDetected: boolean;
  hostError?: string;
}

const SENTINEL = '__ACTHARNESS_DONE__';

type LineResult = { line: string } | { closed: true };

export class PwshSession {
  private proc: ChildProcess | null = null;
  private alive = false;
  private closed = false;
  private closeExitCode: number | null = null;
  private lineBuffer: string[] = [];
  private pendingResolve: ((r: LineResult) => void) | null = null;
  private hostStderr = '';

  spawn(): void {
    const child = spawn('pwsh', ['-NonInteractive', '-File', HOST_SCRIPT], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.proc = child;
    this.alive = true;

    child.stderr!.on('data', (chunk: Buffer) => {
      this.hostStderr += chunk.toString();
    });

    const rl = createInterface({ input: child.stdout! });
    rl.on('line', (line: string) => {
      if (this.pendingResolve) {
        const resolve = this.pendingResolve;
        this.pendingResolve = null;
        resolve({ line });
      } else {
        this.lineBuffer.push(line);
      }
    });

    child.on('close', (code: number | null) => {
      this.alive = false;
      this.closed = true;
      this.closeExitCode = code;
      if (this.pendingResolve) {
        const resolve = this.pendingResolve;
        this.pendingResolve = null;
        resolve({ closed: true });
      }
    });
  }

  isAlive(): boolean {
    return this.alive;
  }

  kill(): void {
    this.alive = false;
    this.proc!.kill('SIGTERM');
    const p = this.proc!;
    const timer = setTimeout(() => p.kill('SIGKILL'), 2_000);
    p.once('close', () => clearTimeout(timer));
  }

  async run(opts: PwshRunOpts): Promise<PwshRunResult> {
    const msg = JSON.stringify({
      scriptPath: opts.scriptPath,
      stdoutPath: opts.stdoutPath,
      stderrPath: opts.stderrPath,
      cwd: opts.cwd,
      env: opts.env,
      coverage: opts.coverage,
    });
    this.proc!.stdin!.write(msg + '\n');

    const lineResult = await this.nextLine(opts.timeout);

    if (lineResult === 'timeout') {
      return { exitCode: 124, timedOut: true, coverage: {}, addTypeDetected: false };
    }
    if ('closed' in lineResult) {
      return { exitCode: this.closeExitCode ?? 1, timedOut: false, coverage: {}, addTypeDetected: false, hostError: this.hostStderr || undefined };
    }

    const { line } = lineResult;
    const field1Start = SENTINEL.length;
    const field1End = line.indexOf(' ', field1Start);
    const exitCode = parseInt(line.slice(field1Start, field1End), 10);
    const rest = line.slice(field1End + 1);
    const lastSpace = rest.lastIndexOf(' ');
    const coverageJson = lastSpace >= 0 ? rest.slice(0, lastSpace) : rest;
    const addTypeField = lastSpace >= 0 ? rest.slice(lastSpace + 1) : 'false';
    const coverage: Record<string, number> = JSON.parse(coverageJson);
    const addTypeDetected = addTypeField === 'true';
    return { exitCode, timedOut: false, coverage, addTypeDetected };
  }

  private nextLine(timeout?: number): Promise<LineResult | 'timeout'> {
    if (this.lineBuffer.length > 0) {
      return Promise.resolve({ line: this.lineBuffer.shift()! });
    }
    if (this.closed) {
      return Promise.resolve({ closed: true });
    }
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      this.pendingResolve = (r: LineResult) => {
        if (timer) clearTimeout(timer);
        resolve(r);
      };
      if (timeout) {
        timer = setTimeout(() => {
          this.pendingResolve = null;
          this.kill();
          resolve('timeout');
        }, timeout);
      }
    });
  }
}
