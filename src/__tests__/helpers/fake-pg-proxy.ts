/**
 * A local stand-in for Neon's proxy (feature-plan-disaster-restore.md §4.1.7, §6.4.1, D1): it speaks just enough of the
 * Postgres startup protocol to answer the way Neon's proxy does for an unknown or deleted endpoint, `28P01` "password
 * authentication failed" after asking for a password, or with a proxy error before authentication, or by closing or
 * never answering. "Login succeeds" and "3D000 after authentication" use the real local Postgres instead.
 *
 * Test URLs carry no `sslmode` (impact analysis §6.13): an SSLRequest is answered `N`.
 */
import net from 'node:net';

export type ProxyMode =
  | { kind: 'auth-fail' } // AuthenticationCleartextPassword, then 28P01 (Neon's answer for an unknown endpoint)
  | { kind: 'startup-error'; code: string; message: string } // an ErrorResponse before authentication
  | { kind: 'close' } // the socket closes after the startup message
  | { kind: 'hang' }; // never answers

export const NEON_PROXY_ERRORS = {
  computeNode: { code: 'XX000', message: "Couldn't connect to compute node" },
  disabled: { code: 'XX000', message: 'The endpoint has been disabled. Enable it using Neon API and retry.' },
  notFound: { code: 'XX000', message: 'The requested endpoint could not be found, or you don\'t have access to it. endpoint not found' },
} as const;

function errorResponse(code: string, message: string): Buffer {
  const fields = Buffer.concat([
    Buffer.from('SFATAL\0'), Buffer.from('VFATAL\0'), Buffer.from(`C${code}\0`), Buffer.from(`M${message}\0`), Buffer.from([0]),
  ]);
  const head = Buffer.alloc(5);
  head.write('E', 0);
  head.writeInt32BE(fields.length + 4, 1);
  return Buffer.concat([head, fields]);
}

function authCleartext(): Buffer {
  const b = Buffer.alloc(9);
  b.write('R', 0);
  b.writeInt32BE(8, 1);
  b.writeInt32BE(3, 5);
  return b;
}

export interface FakePgProxy {
  port: number;
  host: string;
  /** Change the answer for new connections. */
  setMode(mode: ProxyMode): void;
  connections(): number;
  close(): Promise<void>;
}

export async function startFakePgProxy(initial: ProxyMode = { kind: 'auth-fail' }): Promise<FakePgProxy> {
  let mode = initial;
  let count = 0;
  const sockets = new Set<net.Socket>();
  const server = net.createServer((sock) => {
    count++;
    sockets.add(sock);
    sock.on('close', () => sockets.delete(sock));
    sock.on('error', () => {});
    const m = mode;
    let buf = Buffer.alloc(0);
    let stage: 'startup' | 'password' | 'done' = 'startup';
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        if (stage === 'startup') {
          if (buf.length < 8) return;
          const len = buf.readInt32BE(0);
          if (buf.length < len) return;
          const code = buf.readInt32BE(4);
          buf = buf.subarray(len);
          if (code === 80877103 || code === 80877104) { sock.write('N'); continue; } // SSL / GSS encryption request
          // The startup message.
          if (m.kind === 'hang') { stage = 'done'; return; }
          if (m.kind === 'close') { stage = 'done'; sock.destroy(); return; }
          if (m.kind === 'startup-error') { stage = 'done'; sock.end(errorResponse(m.code, m.message)); return; }
          stage = 'password';
          sock.write(authCleartext());
          continue;
        }
        if (stage === 'password') {
          if (buf.length < 5) return;
          const len = buf.readInt32BE(1);
          if (buf.length < len + 1) return;
          buf = buf.subarray(len + 1);
          stage = 'done';
          sock.end(errorResponse('28P01', 'password authentication failed for user "neondb_owner"'));
          return;
        }
        return;
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as net.AddressInfo).port;
  return {
    port,
    host: '127.0.0.1',
    setMode(next) { mode = next; },
    connections: () => count,
    async close() {
      for (const s of sockets) s.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
