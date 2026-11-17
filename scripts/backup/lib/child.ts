/**
 * Child processes (pg_dump, pg_restore) with a minimal environment, error listeners on every stdio stream, and stderr
 * fully drained (the first 4 KB kept for the error summary, which never stores it as text).
 */
import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process';

export type SpawnFn = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;
export const realSpawn: SpawnFn = (command, args, options) => nodeSpawn(command, args, options);

export interface RunningChild {
  child: ChildProcess;
  /** Resolves on 'close' with the exit code and signal; never rejects (a spawn error resolves with code null). */
  closed: Promise<{ code: number | null; signal: NodeJS.Signals | null; spawnError?: Error }>;
  stderr: () => string;
  kill: () => void;
}

export function startChild(spawn: SpawnFn, bin: string, args: string[], env: Record<string, string>, stdin: 'pipe' | 'ignore'): RunningChild {
  const child = spawn(bin, args, { env: env as unknown as NodeJS.ProcessEnv, stdio: [stdin, 'pipe', 'pipe'] });
  let err = '';
  let spawnError: Error | undefined;
  child.stderr?.on('data', (b: Buffer) => { if (err.length < 4096) err += b.toString('utf8').slice(0, 4096 - err.length); });
  child.stderr?.on('error', () => {});
  child.stdout?.on('error', () => {});
  child.stdin?.on('error', () => {}); // EPIPE when the child exits early: the close code reports the failure
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null; spawnError?: Error }>((resolve) => {
    child.once('error', (e) => { spawnError = e; });
    child.once('close', (code, signal) => resolve({ code, signal, spawnError }));
  });
  return {
    child,
    closed,
    stderr: () => err,
    kill: () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); },
  };
}
