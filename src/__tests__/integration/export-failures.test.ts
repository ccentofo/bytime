import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createWorkspaceZipStream, ExportTooLargeError, type ExportSnapshot, type WorkspaceZipOptions } from '@/lib/export/workspace-export';
import { makeWorld, type World } from './export-harness';
import { waitUntil } from './backup-helpers';

/**
 * feature-plan-cloud-export.md §11 T5 (failure paths and the record rule), T20 (the 45-minute deadline, injected short),
 * T25 (the snapshot's server-side timeouts; the app's call unchanged) and D2 (the hard exit). Every wait is on real
 * state (rows, fake-bucket calls, the run's own signal), never a fixed sleep.
 */

const hasCp = Boolean(process.env.CONTROL_PLANE_DATABASE_URL);
const d = hasCp ? describe : describe.skip;
const ROOT = path.resolve(__dirname, '../../..');

let worlds: World[] = [];
afterEach(async () => {
  for (const w of worlds) await w.cleanup();
  worlds = [];
});
async function world(o: Parameters<typeof makeWorld>[0] = {}) {
  const w = await makeWorld(o);
  worlds.push(w);
  return w;
}
const rows = async (w: World) => ({
  deliveries: await w.cp`SELECT id FROM export_deliveries WHERE tenant_id = ${w.tenant.id}`,
  holds: await w.cp`SELECT id FROM export_holds WHERE tenant_id = ${w.tenant.id}`,
  notices: await w.cp`SELECT id FROM tenant_notices WHERE tenant_id = ${w.tenant.id}`,
  audits: await w.cp`SELECT id FROM tenant_audit_events WHERE tenant_id = ${w.tenant.id}`,
});
const nothingRecorded = async (w: World) => {
  const r = await rows(w);
  expect([r.deliveries.length, r.holds.length, r.notices.length, r.audits.length]).toEqual([0, 0, 0, 0]);
};

/** A ZIP body that sends one chunk, then fails with `err` (calling onError as the real stream does). */
const failingZip = (err: Error) => (snapshot: ExportSnapshot, opts: WorkspaceZipOptions) => new ReadableStream<Uint8Array>({
  start(controller) { controller.enqueue(new Uint8Array(1024)); },
  async pull(controller) {
    await snapshot.close(false);
    opts.onError?.(err);
    controller.error(err);
  },
}, { highWaterMark: 0 });

/** A ZIP body that sends one chunk and then never another (a half-open socket). */
const stalledZip = (snapshot: ExportSnapshot) => new ReadableStream<Uint8Array>({
  start(controller) { controller.enqueue(new Uint8Array(2048)); },
  pull() { return new Promise<void>(() => {}); },
  async cancel() { await snapshot.close(false); },
}, { highWaterMark: 0 });

d('T5: failures before the upload completes → aborted, deleted, nothing recorded', () => {
  it('the ZIP limit → failed too-large', async () => {
    const w = await world();
    const r = await w.run({ mode: 'deliver' }, { zipStream: failingZip(new ExportTooLargeError('Export exceeds 4 GiB (zip limit); contact the lead.')) });
    expect(r.exitCode).toBe(1);
    expect(r.line).toBe(`export failed: deliver, workspace ${w.tenant.id}, too-large`);
    expect(w.bucket.aborted.length).toBe(1);
    expect(w.bucket.completed).toEqual([]);
    expect(w.bucket.objects.size).toBe(0);
    expect(w.bucket.deleted).toEqual(w.bucket.started);
    await nothingRecorded(w);
  });

  it('a database error mid-stream → failed database-error', async () => {
    const w = await world();
    const r = await w.run({ mode: 'hold', reason: 'litigation' }, { zipStream: failingZip(Object.assign(new Error('terminating connection due to administrator command'), { name: 'PostgresError', code: '57P01' })) });
    expect(r.line).toBe(`export failed: hold, workspace ${w.tenant.id}, database-error`);
    expect(w.bucket.objects.size).toBe(0);
    await nothingRecorded(w);
    expect(w.lines.join('\n')).not.toContain('administrator command'); // summaries only
  });

  it('an upload error → failed upload-error, the upload aborted, any object deleted', async () => {
    const w = await world();
    w.bucket.failUploadAfterBytes = 100;
    const r = await w.run({ mode: 'deliver' });
    expect(r.line).toBe(`export failed: deliver, workspace ${w.tenant.id}, upload-error`);
    expect(w.bucket.aborted.length).toBe(1);
    expect(w.bucket.objects.size).toBe(0);
    expect(w.bucket.deleted.length).toBe(1);
    await nothingRecorded(w);
  });
});

d('T5: a record error after the transaction started → the object is kept, outcome unknown, exit 1', () => {
  it('a lost acknowledgement (COMMIT succeeded): object kept, "outcome unknown: delivery <id>", exit 1; the rows are there (committed)', async () => {
    const w = await world();
    const r = await w.run({ mode: 'deliver' }, { hooks: { afterCommit: async () => { throw Object.assign(new Error('write CONNECTION_CLOSED'), { code: 'CONNECTION_CLOSED' }); } } });
    expect(r.exitCode).toBe(1);
    const [row] = await w.cp<{ id: string; s3Key: string }[]>`SELECT id::text AS id, s3_key AS "s3Key" FROM export_deliveries WHERE tenant_id = ${w.tenant.id}`;
    expect(row).toBeDefined();
    expect(r.line).toBe(`export outcome unknown: deliver, workspace ${w.tenant.id}, delivery ${row.id}`);
    expect(w.bucket.objects.has(row.s3Key)).toBe(true);
    expect(w.bucket.deleted).toEqual([]);
    expect(w.pub.sent).toEqual([r.line]);
  });

  it('a stop landing mid-record (before COMMIT is sent): outcome unknown at once, the object kept; the run never deletes it afterwards', async () => {
    const w = await world();
    const stop = new AbortController();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let runPid: number | null = null;
    const r = await w.run({ mode: 'deliver' }, {
      stopSignal: stop.signal,
      hooks: {
        beforeCommit: async (tx) => {
          runPid = (await tx<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`)[0].pid; // the run's own backend
          stop.abort();
          await gate;
        },
      },
    });
    expect(r.exitCode).toBe(1);
    expect(r.line).toMatch(new RegExp(`^export outcome unknown: deliver, workspace ${w.tenant.id}, delivery [0-9a-f-]{36}$`));
    const id = r.line.split(' ').pop()!;
    release();
    // The run closed its client (production: the process exits), so its open transaction ends without a COMMIT. Wait on
    // the real state of THAT backend only: gone, or no longer inside a transaction (other files' sessions don't matter).
    expect(runPid).not.toBeNull();
    await waitUntil(async () => (await w.cp`SELECT 1 FROM pg_stat_activity WHERE pid = ${runPid} AND xact_start IS NOT NULL`).length === 0);
    expect((await rows(w)).deliveries.length).toBe(0); // it never committed: the sweep erases the orphan after a day
    expect([...w.bucket.objects.keys()].some((k) => k.startsWith(`delivery/${id}/`))).toBe(true);
    expect(w.bucket.deleted).toEqual([]);
  });

  it('T20: the deadline firing mid-record leaves the object (outcome unknown)', async () => {
    const w = await world();
    const r = await w.run({ mode: 'hold', reason: 'r' }, {
      deadlineMs: 8_000,
      hooks: { beforeCommit: async (_tx, signal) => { if (!signal.aborted) await new Promise((res) => signal.addEventListener('abort', res, { once: true })); } },
    });
    expect(r.exitCode).toBe(1);
    expect(r.line).toMatch(new RegExp(`^export outcome unknown: hold, workspace ${w.tenant.id}, hold [0-9a-f-]{36}$`));
    expect(w.bucket.objects.size).toBe(1);
    expect(w.bucket.deleted).toEqual([]);
  }, 30_000);

  it('a server error before COMMIT (statement timeout inside the record) certainly committed nothing → deleted at once', async () => {
    const w = await world();
    const r = await w.run({ mode: 'deliver' }, { hooks: { beforeCommit: async (tx) => { await tx`SELECT pg_sleep(11)`; } } });
    expect(r.line).toBe(`export failed: deliver, workspace ${w.tenant.id}, database-error`);
    expect(w.bucket.objects.size).toBe(0);
    await nothingRecorded(w);
  }, 30_000);

  it('the deadline before BEGIN certainly committed nothing → deleted at once, failed deadline', async () => {
    const w = await world();
    const r = await w.run({ mode: 'deliver' }, {
      deadlineMs: 8_000,
      hooks: { beforeBegin: async (signal) => { if (!signal.aborted) await new Promise((res) => signal.addEventListener('abort', res, { once: true })); } },
    });
    expect(r.line).toBe(`export failed: deliver, workspace ${w.tenant.id}, deadline`);
    expect(w.bucket.objects.size).toBe(0);
    await nothingRecorded(w);
  }, 30_000);
});

d('T20: the 45-minute deadline (injected short) aborts a stalled build before the upload completes', () => {
  it('a stalled stream: the deadline aborts the upload, deletes the partial object, records nothing; failed deadline', async () => {
    const w = await world();
    const r = await w.run({ mode: 'deliver' }, { deadlineMs: 1_500, zipStream: stalledZip });
    expect(r.line).toBe(`export failed: deliver, workspace ${w.tenant.id}, deadline`);
    expect(w.bucket.aborted.length).toBe(1);
    expect(w.bucket.completed).toEqual([]);
    expect(w.bucket.deleted.length).toBe(1);
    await nothingRecorded(w);
  }, 30_000);

  it('a SIGTERM stop mid-build → failed stopped', async () => {
    const w = await world();
    const stop = new AbortController();
    const r = await w.run({ mode: 'deliver' }, { stopSignal: stop.signal, zipStream: (s) => { setImmediate(() => stop.abort()); return stalledZip(s); } });
    expect(r.line).toBe(`export failed: deliver, workspace ${w.tenant.id}, stopped`);
    await nothingRecorded(w);
  });

  it('D2: a run hung past its deadline exits through the hard exit, publishing its line', async () => {
    const w = await world();
    // Hang wherever the deadline lands (a loaded runner may still be building at 300 ms): after the upload (the hook) and
    // in the abort path's delete. Either way the run never returns, and only the hard exit ends it.
    w.bucket.delete = () => new Promise<void>(() => {});
    let code: number | null = null;
    const exited = new Promise<void>((resolve) => {
      void w.run({ mode: 'deliver' }, {
        deadlineMs: 300, hardExitAfterDeadlineMs: 300,
        hardExit: (c) => { code = c; resolve(); },
        hooks: { afterUpload: () => new Promise<void>(() => {}) }, // never returns: the run hangs
      });
    });
    await exited;
    expect(code).toBe(1);
    expect(w.lines).toContain('hard exit: still running 5 minutes after the deadline');
    await waitUntil(() => w.pub.sent.length > 0);
    expect(w.pub.sent).toEqual([`export failed: deliver, workspace ${w.tenant.id}, deadline`]);
  }, 60_000); // the world's set-up (a migrated workspace) alone can take 20 s on a loaded runner
});

d('FR6: exactly one closing SNS line per run', () => {
  it('the hard exit firing while finish() is still publishing waits for that publish instead of sending a second line', async () => {
    const w = await world({ tenant: { status: 'deleted' } });
    const sent: string[] = [];
    let exitedAt = 0;
    let publishedAt = 0;
    const slowPublish = async (_s: string, m: string) => { await new Promise((r) => setTimeout(r, 1_500)); sent.push(m); publishedAt = Date.now(); };
    const exited = new Promise<void>((resolve) => {
      void w.run({ mode: 'deliver' }, {
        publish: slowPublish, deadlineMs: 200, hardExitAfterDeadlineMs: 200,
        hardExit: () => { exitedAt = Date.now(); resolve(); },
      });
    });
    await exited;
    expect(sent).toEqual([`export refused: deliver, workspace ${w.tenant.id}, not-exportable`]);
    expect(exitedAt).toBeGreaterThanOrEqual(publishedAt); // it waited for the in-flight line
    expect(w.lines.filter((l) => /^export (refused|failed|delivered|held|released|outcome unknown):/.test(l))).toEqual([`export refused: deliver, workspace ${w.tenant.id}, not-exportable`]);
  }, 60_000);
});

d('T25: openExportSnapshot(url, opts): the task\'s server-side timeouts; the app\'s call unchanged', () => {
  it('statement_timeout and idle_in_transaction_session_timeout are 45 minutes inside the task\'s snapshot', async () => {
    const w = await world();
    const seen: Record<string, string> = {};
    const r = await w.run({ mode: 'deliver' }, {
      zipStream: (snapshot, opts) => {
        const real = createWorkspaceZipStream(snapshot, opts);
        let checked = false;
        const reader = real.getReader();
        return new ReadableStream<Uint8Array>({
          async pull(controller) {
            if (!checked) {
              checked = true;
              const [row] = await snapshot.conn<{ st: string; idle: string }[]>`SELECT current_setting('statement_timeout') AS st, current_setting('idle_in_transaction_session_timeout') AS idle`;
              seen.st = row.st;
              seen.idle = row.idle;
            }
            const { value, done } = await reader.read();
            if (done) controller.close(); else controller.enqueue(value);
          },
          cancel(reason) { return reader.cancel(reason); },
        }, { highWaterMark: 0 });
      },
    });
    expect(r.exitCode, w.lines.join('\n')).toBe(0);
    expect(seen).toEqual({ st: '45min', idle: '45min' });
  });

  it('the in-app export route still calls openExportSnapshot with the URL only', () => {
    const route = readFileSync(path.join(ROOT, 'src/app/api/export/workspace/route.ts'), 'utf8');
    const calls = [...route.matchAll(/openExportSnapshot\(([^)]*)\)/g)].map((m) => m[1]);
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) expect(c.split(',').length).toBe(1);
  });
});
