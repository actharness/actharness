// ShellSandbox — implements SandboxFactory by spawning child processes.
// Writes the script to a temp file, runs the shell, captures stdout/stderr.

import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { SandboxFactory, ShellSandboxOptions, ShellSandboxResult } from '@actharness/core';
import { runInSandbox } from '@actharness/node';
import { ShellNetworkScope, ensureSessionCa } from '@actharness/network-mock';
import { parseShCoverage } from './sh-coverage.js';
import { resolveVenvPython } from './python-venv.js';
import { parsePythonCoverageJson } from './python-coverage.js';
import { PwshSessionPool } from './pwsh-session-pool.js';

const SH_COVERAGE_HEADER = `PS4='::COVERED::\${LINENO}::'\nexport PS4\nset -x\n`;
const SH_COVERAGE_HEADER_LINE_COUNT = 3;


function buildShellArgv(shell: string, scriptPath: string): { bin: string; args: string[] } {
  const normalized = shell.trim();
  if (normalized === 'bash') {
    return { bin: 'bash', args: ['--noprofile', '--norc', '-eo', 'pipefail', scriptPath] };
  }
  if (normalized === 'sh') {
    return { bin: 'sh', args: ['-e', scriptPath] };
  }
  if (normalized === 'pwsh' || normalized === 'powershell') {
    return { bin: 'pwsh', args: ['-NonInteractive', '-command', `. '${scriptPath}'`] };
  }
  if (normalized === 'cmd') {
    return { bin: 'cmd', args: ['/D', '/E:ON', '/V:OFF', '/S', '/C', `CALL "${scriptPath}"`] };
  }
  if (normalized === 'python' || normalized === 'python3') {
    return { bin: normalized, args: [scriptPath] };
  }
  // Custom shell with {0} placeholder
  if (normalized.includes('{0}')) {
    const expanded = normalized.replace('{0}', scriptPath);
    const parts = expanded.split(' ');
    return { bin: parts[0]!, args: parts.slice(1) };
  }
  return { bin: normalized, args: [scriptPath] };
}

function spawnAndCapture(
  bin: string,
  args: string[],
  env: Record<string, string>,
  cwd: string,
  timeout: number | undefined,
): Promise<{ exitCode: number; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const child = spawn(bin, args, {
      env,
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');

    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });

    let timer: ReturnType<typeof setTimeout> | undefined;
    if (timeout) {
      timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
        const killTimer = setTimeout(() => child.kill('SIGKILL'), 2_000);
        child.once('close', () => clearTimeout(killTimer));
      }, timeout);
    }

    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({ exitCode: timedOut ? 124 : (code ?? 1), stdout, stderr, timedOut });
    });
  });
}

export class ShellSandbox implements SandboxFactory {
  private pool = new PwshSessionPool();

  async shell(opts: ShellSandboxOptions): Promise<ShellSandboxResult> {
    const normalized = opts.shell.trim();
    const scriptDir = mkdtempSync(join(tmpdir(), 'actharness-script-'));
    const ext = (normalized === 'python' || normalized === 'python3') ? '.py'
      : normalized === 'node' ? '.js'
      : normalized === 'cmd' ? '.cmd'
      : (normalized === 'pwsh' || normalized === 'powershell') ? '.ps1'
      : '.sh';
    const scriptPath = join(scriptDir, `script${ext}`);

    const isPython = normalized === 'python' || normalized === 'python3';
    const coverageEnabled = opts.coverage === true && (normalized === 'sh' || normalized === 'bash');
    const pwshCoverageEnabled = opts.coverage === true && (normalized === 'pwsh' || normalized === 'powershell');
    const pythonCoverageRequested = opts.coverage === true && isPython;

    const isPwsh = normalized === 'pwsh' || normalized === 'powershell';

    if (normalized === 'node') {
      writeFileSync(scriptPath, opts.script, { mode: 0o700 });
      const hasProtocol = !!(opts.env.GITHUB_OUTPUT && opts.env.GITHUB_ENV && opts.env.GITHUB_STATE);
      const nodeRaw = await runInSandbox({
        entrypoint: scriptPath,
        env: opts.env,
        cwd: opts.cwd,
        ...(hasProtocol ? {
          protocolFiles: {
            output: opts.env.GITHUB_OUTPUT!,
            env: opts.env.GITHUB_ENV!,
            state: opts.env.GITHUB_STATE!,
            path: opts.env.GITHUB_PATH ?? '',
            summary: opts.env.GITHUB_STEP_SUMMARY ?? '',
          },
        } : {}),
      });

      const jsCoverageWithSource = nodeRaw.jsCoverage.map((e) => ({ ...e, source: opts.script }));
      rmSync(scriptDir, { recursive: true, force: true });
      return {
        exitCode: nodeRaw.exitCode,
        stdout: nodeRaw.stdout,
        stderr: nodeRaw.stderr,
        timedOut: false,
        ...(opts.coverage ? { shellCoverage: { nodeCoverageData: jsCoverageWithSource } } : {}),
      };
    }

    // ── pwsh persistent session path ──────────────────────────────────────────
    if (isPwsh && opts.runId !== undefined && opts.pwshIsolation !== 'process') {
      const stepDir = mkdtempSync(join(tmpdir(), 'actharness-step-'));
      const stdoutPath = join(stepDir, 'stdout');
      const stderrPath = join(stepDir, 'stderr');
      writeFileSync(stdoutPath, '');
      writeFileSync(stderrPath, '');

      const scope = new ShellNetworkScope();
      await scope.drainAndStart();

      let scriptContent = opts.script;
      let env = { ...opts.env };
      if (scope.isActive()) {
        const ca = await ensureSessionCa();
        Object.assign(env, scope.getProxyEnv(ca.certPath));
        scriptContent = scope.getPwshPrefix() + scriptContent;
      }

      writeFileSync(scriptPath, scriptContent, { mode: 0o700 });

      const session = this.pool.getOrCreate(opts.runId);
      const stepResult = await session.run({
        scriptPath,
        stdoutPath,
        stderrPath,
        cwd: opts.cwd,
        env,
        coverage: pwshCoverageEnabled,
        timeout: opts.timeout,
      });

      scope.collectHits();
      await scope.stop();

      if (!session.isAlive()) {
        this.pool.invalidate(opts.runId);
      } else if (stepResult.addTypeDetected) {
        this.pool.roll(opts.runId);
      }

      const stdout = readFileSync(stdoutPath, 'utf8');
      const scriptStderr = readFileSync(stderrPath, 'utf8');
      const stderrParts = [scriptStderr, stepResult.hostError ? `[pwsh host error] ${stepResult.hostError.trim()}` : ''].filter(Boolean);
      const stderr = stderrParts.join('\n');

      const result: ShellSandboxResult = {
        exitCode: stepResult.exitCode,
        stdout,
        stderr,
        timedOut: stepResult.timedOut,
      };

      if (pwshCoverageEnabled) {
        const lineHits = Object.fromEntries(
          Object.entries(stepResult.coverage).map(([k, v]) => [Number(k), v]),
        ) as Record<number, number>;
        result.shellCoverage = { lineHits };
      }

      rmSync(scriptDir, { recursive: true, force: true });
      rmSync(stepDir, { recursive: true, force: true });
      return result;
    }

    // ── Proxy-based network mocking for all non-node shells ───────────────────
    const scope = new ShellNetworkScope();
    await scope.drainAndStart();

    let env = { ...opts.env };

    if (scope.isActive()) {
      const ca = await ensureSessionCa();
      Object.assign(env, scope.getProxyEnv(ca.certPath));
    }

    let scriptContent = opts.script;

    if (coverageEnabled) {
      scriptContent = SH_COVERAGE_HEADER + scriptContent;
    }

    writeFileSync(scriptPath, scriptContent, { mode: 0o700 });

    let venvPython: string | null = null;
    let pythonCoverageEnabled = false;
    let warnNoVenv = false;

    if (pythonCoverageRequested) {
      try {
        venvPython = await resolveVenvPython(normalized as 'python' | 'python3');
        pythonCoverageEnabled = true;
      } catch {
        warnNoVenv = true;
      }
    }

    let bin: string;
    let args: string[];
    let covDir: string | undefined;

    if (pythonCoverageEnabled && venvPython) {
      covDir = mkdtempSync(join(tmpdir(), 'actharness-pycov-'));
      const dataFile = join(covDir, '.coverage');
      bin = venvPython;
      args = ['-m', 'coverage', 'run', '--branch', `--data-file=${dataFile}`, scriptPath];
    } else {
      const argv = buildShellArgv(opts.shell, scriptPath);
      bin = argv.bin;
      args = argv.args;
    }

    const raw = await spawnAndCapture(bin, args, env, opts.cwd, opts.timeout);

    // Collect proxy hits into mock handles
    scope.collectHits();
    await scope.stop();

    const result: ShellSandboxResult = {
      exitCode: raw.exitCode,
      stdout: raw.stdout,
      stderr: raw.stderr,
      timedOut: raw.timedOut,
    };

    if (warnNoVenv) {
      result.stdout = result.stdout + '::warning::python coverage skipped — binary not found\n';
    }

    if (coverageEnabled) {
      result.shellCoverage = { lineHits: parseShCoverage(raw.stderr, SH_COVERAGE_HEADER_LINE_COUNT) };
    }

    if (pythonCoverageEnabled && venvPython && covDir) {
      const dataFile = join(covDir, '.coverage');
      const jsonFile = join(covDir, 'coverage.json');
      try {
        execFileSync(venvPython, ['-m', 'coverage', 'json', `--data-file=${dataFile}`, '-o', jsonFile], { stdio: 'ignore' });
        const json = readFileSync(jsonFile, 'utf8');
        result.shellCoverage = { pythonCoverageData: parsePythonCoverageJson(json, scriptPath) };
      } finally {
        rmSync(covDir, { recursive: true, force: true });
      }
    }

    rmSync(scriptDir, { recursive: true, force: true });

    return result;
  }

  endRun(runId: string): void {
    this.pool.endRun(runId);
  }
}
