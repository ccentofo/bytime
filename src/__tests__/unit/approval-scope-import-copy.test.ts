import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';

/**
 * feature-plan-approval-scope.md S7, §5: the import's approval-scope tab says what it grants (one supervisor approves one
 * CLIN per row), that the supervisors must already exist, and its template uses supervisor examples with the same
 * `Email` header.
 */
const ROOT = path.resolve(__dirname, '../../..');

describe('the approval-scope import tab (S7)', () => {
  const src = readFileSync(path.join(ROOT, 'src/app/(app)/settings/import/ImportClient.tsx'), 'utf8');

  it('the copy: what a row grants, the order note, the tab name', () => {
    expect(src).toContain('description="Give supervisors approval scope on CLINs. Each row lets one supervisor approve employees on one CLIN."');
    expect(src).toMatch(/importOrderNote="The supervisors must already exist/);
    expect(src).toContain('<Tabs.Tab value="assignments">Approval scope</Tabs.Tab>');
    expect(src).not.toContain('Bulk assign employees to CLINs');
  });

  it('the template keeps the Email header and uses supervisor examples', () => {
    const [header, ...rows] = readFileSync(path.join(ROOT, 'public/templates/assignment-import-template.csv'), 'utf8').trim().split('\n');
    expect(header).toBe('Email,Contract Number,CLIN Number');
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.split(',')[0]).toMatch(/supervisor@/);
  });
});
