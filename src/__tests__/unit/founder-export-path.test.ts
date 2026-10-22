import { describe, it, expect } from 'vitest';
import { refusedOutputReason } from '@/lib/export/founder-export-path';

// F2: a founder-held export copy must never land somewhere that syncs or backs up past its destroy-by date.
const HOME = '/Users/founder';
const REPO = '/Users/founder/dev/cadenzpoint';

describe('refusedOutputReason (F2 founder export location)', () => {
  it.each([
    [`${REPO}`, 'repository'],
    [`${REPO}/exports`, 'repository'],
    [`${HOME}/Documents/exports`, 'Documents'],
    [`${HOME}/Desktop`, 'Desktop'],
    [`${HOME}/Library/Mobile Documents/com~apple~CloudDocs/x`, 'Mobile Documents'],
    [`${HOME}/Library/CloudStorage/GoogleDrive-a/x`, 'CloudStorage'],
    [`/Volumes/ext/Dropbox/exports`, 'cloud-synced'],
    [`/Volumes/ext/OneDrive - Personal/x`, 'cloud-synced'],
    [`/Volumes/ext/Google Drive/x`, 'cloud-synced'],
    [`/Volumes/ext/iCloud Drive/x`, 'cloud-synced'],
    [`${HOME}/documents/out`, 'Documents'], // case-insensitive volume: same folder
    [`${HOME}/DESKTOP`, 'Desktop'],
    [`${HOME}/library/cloudstorage/x`, 'CloudStorage'],
  ])('refuses %s', (dir, why) => {
    expect(refusedOutputReason(dir, REPO, HOME)).toContain(why);
  });

  it.each([
    [`${HOME}/founder-exports`],
    [`/Volumes/EncryptedUSB/exports`],
    [`${HOME}/dev/other-project-exports`],
    [`${HOME}/DocumentsArchive`], // a sibling that merely shares a prefix is not inside ~/Documents
  ])('allows %s', (dir) => {
    expect(refusedOutputReason(dir, REPO, HOME)).toBeNull();
  });
});
