import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { controlPlaneId } from '../../../scripts/backup/lib/keys';
import { parseBackupLine } from '../../../scripts/backup/lib/log-reader';
import {
  CANARY_PROJECT_NAME, CONTROL_PLANE_REBUILD_NAME_RE, CONTROL_PLANE_REHEARSAL_NAME_RE, controlPlaneRebuildName, controlPlaneRehearsalName,
  REBUILD_NAME_RE, rebuildName, windowProjectType,
} from '../../../scripts/backup/lib/project-names';
import { isValidSlug } from '@/lib/tenant/slug-rules';

/** feature-plan-control-plane-disaster.md §11 T1 (the id and the log line) and T24 (system names and reserved slugs). */

const URL_A = 'postgresql://u:p@ep-cool-1-pooler.c-2.us-east-1.aws.neon.tech/db';
const HASH = createHash('sha256').update('ep-cool-1.c-2.us-east-1.aws.neon.tech').digest('hex').slice(0, 12);
const SHA = 'a'.repeat(64);

describe('T1: controlPlaneId(url, env)', () => {
  it('prod and staging are returned as they are; anything else throws; unset → the host hash', () => {
    expect(controlPlaneId(URL_A, { BACKUP_CONTROL_PLANE_ID: 'prod' })).toBe('prod');
    expect(controlPlaneId(URL_A, { BACKUP_CONTROL_PLANE_ID: 'staging' })).toBe('staging');
    for (const bad of ['probe', 'Prod', 'PROD', 'prod ', '', HASH]) expect(() => controlPlaneId(URL_A, { BACKUP_CONTROL_PLANE_ID: bad }), bad).toThrow(/prod or staging/);
    expect(controlPlaneId(URL_A, {})).toBe(HASH);
  });
  it('a rebuilt control plane (another host) keeps the id; the host hash would change', () => {
    const rebuilt = 'postgresql://u:p@ep-new-9-pooler.us-east-1.aws.neon.tech/cadenzpoint_control';
    expect(controlPlaneId(rebuilt, { BACKUP_CONTROL_PLANE_ID: 'prod' })).toBe(controlPlaneId(URL_A, { BACKUP_CONTROL_PLANE_ID: 'prod' }));
    expect(controlPlaneId(rebuilt, {})).not.toBe(controlPlaneId(URL_A, {}));
  });
});

describe('T1: parseBackupLine', () => {
  const line = (cp: string, target = 'control-plane', id = 'control-plane') => `BACKUP ${cp} ${target} ${id} control-plane ecs-1 v1/${cp}/${target}/${id}/2026/11/18/ecs-1-abcd1234.dump.enc ${SHA} 123`;
  it('accepts prod, staging and host-hash ids (with and without row-failed)', () => {
    for (const cp of ['prod', 'staging', HASH]) {
      expect(parseBackupLine(line(cp))).toMatchObject({ cp, target: 'control-plane', id: 'control-plane', sha256: SHA, bytes: 123 });
      expect(parseBackupLine(`${line(cp)} row-failed`)).toMatchObject({ cp });
    }
  });
  it('rejects any other id', () => {
    for (const cp of ['probe', 'Prod', 'prodx', 'a'.repeat(11), 'g'.repeat(12), 'a'.repeat(13)]) expect(parseBackupLine(line(cp)), cp).toBeNull();
  });
});

describe('T24: system project names (§6.11)', () => {
  const now = new Date('2026-11-18T09:08:07.654Z');
  it('each builder round-trips through its regex, with the 14-digit stamp and the try number', () => {
    expect(rebuildName('abcdef12-3456-4789-8abc-def012345678', now, 2)).toBe('cadenzpoint-r-abcdef12-20261118090807-2');
    expect(controlPlaneRebuildName(now, 1)).toBe('cadenzpoint-control-r20261118090807-1');
    expect(controlPlaneRehearsalName(now, 3)).toBe('cadenzpoint-rehearse-cp-20261118090807-3');
    expect(REBUILD_NAME_RE.test(rebuildName('abcdef12-3456-4789-8abc-def012345678', now, 2))).toBe(true);
    expect(CONTROL_PLANE_REBUILD_NAME_RE.test(controlPlaneRebuildName(now, 1))).toBe(true);
    expect(CONTROL_PLANE_REHEARSAL_NAME_RE.test(controlPlaneRehearsalName(now, 3))).toBe(true);
    // The patterns don't overlap.
    expect(CONTROL_PLANE_REBUILD_NAME_RE.test(controlPlaneRehearsalName(now, 3))).toBe(false);
    expect(REBUILD_NAME_RE.test(controlPlaneRebuildName(now, 1))).toBe(false);
    expect(CONTROL_PLANE_REBUILD_NAME_RE.test('cadenzpoint-control-risk')).toBe(false);
    expect(CONTROL_PLANE_REBUILD_NAME_RE.test('cadenzpoint-control-prod')).toBe(false);
  });
  it('retries in the same minute get distinct names', () => {
    expect(controlPlaneRebuildName(now, 1)).not.toBe(controlPlaneRebuildName(now, 2));
    expect(controlPlaneRehearsalName(now, 1)).not.toBe(controlPlaneRehearsalName(new Date(now.getTime() + 30_000), 2));
  });
  it('windowProjectType: a 3c rebuild before a signup; a valid slug → signup; everything else → other', () => {
    expect(windowProjectType(rebuildName('abcdef12-3456-4789-8abc-def012345678', now, 1))).toEqual({ type: 'rebuild', slug: null });
    expect(windowProjectType('cadenzpoint-r-and-d')).toEqual({ type: 'signup', slug: 'r-and-d' });
    expect(windowProjectType('cadenzpoint-acme')).toEqual({ type: 'signup', slug: 'acme' });
    expect(windowProjectType('cadenzpoint-control-prod')).toEqual({ type: 'other', slug: null });
    expect(windowProjectType('my-side-project')).toEqual({ type: 'other', slug: null });
    expect(windowProjectType('cadenzpoint-Bad_Slug')).toEqual({ type: 'other', slug: null });
  });
});

describe('T24: reserved slugs (§6.7)', () => {
  const now = new Date('2026-11-18T09:08:07Z');
  const slugOf = (name: string) => name.replace(/^cadenzpoint-/, '');
  it('every exact system name is refused', () => {
    for (const s of ['control-prod', 'control-staging', 'restore-tests', 'recoverable-canary', slugOf(CANARY_PROJECT_NAME)]) expect(isValidSlug(s), s).toBe(false);
  });
  it('the slug part of every §6.11 name, built by its builder, is refused', () => {
    for (let tryNo = 1; tryNo <= 12; tryNo++) {
      for (const name of [rebuildName('0a1b2c3d-1111-4222-8333-444455556666', now, tryNo), controlPlaneRebuildName(now, tryNo), controlPlaneRehearsalName(now, tryNo)]) {
        expect(isValidSlug(slugOf(name)), name).toBe(false);
      }
    }
  });
  it('ordinary slugs stay valid, including near misses', () => {
    for (const s of ['acme', 'globex', 'r-and-d', 'control', 'control-room', 'rehearse', 'restore', 'r-12345', 'control-r2', 'rehearse-cp']) expect(isValidSlug(s), s).toBe(true);
    for (const s of ['www', 'admin', '-x', 'A', '']) expect(isValidSlug(s), s).toBe(false);
  });
});
