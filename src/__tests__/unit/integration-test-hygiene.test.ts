import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

// Integration tests talk to Postgres. vi.useFakeTimers() with no options fakes setTimeout,
// setImmediate, etc., which stalls the postgres driver: every query then hangs until the 30s
// hook timeout. Integration tests must fake only the clock: vi.useFakeTimers({ toFake: ['Date'] }).
describe('integration test hygiene', () => {
  it('integration tests never fake every timer', () => {
    const dir = path.resolve(__dirname, '../integration');
    const offenders = fs.readdirSync(dir)
      .filter((f) => f.endsWith('.ts'))
      .filter((f) => /vi\.useFakeTimers\(\s*\)/.test(fs.readFileSync(path.join(dir, f), 'utf8')));
    expect(offenders, `use vi.useFakeTimers({ toFake: ['Date'] }) in: ${offenders.join(', ')}`).toEqual([]);
  });
});
