import path from 'node:path';

/**
 * F2: where a founder-held export may NOT be written — anywhere a copy could escape: the repository, iCloud
 * Desktop/Documents, iCloud Drive / cloud-storage folders, or any Dropbox / OneDrive / Google Drive folder.
 * `dir`, `repoRoot` and `home` must be real (symlink-resolved, e.g. realpathSync.native) absolute paths. Returns the reason, or null.
 */
export function refusedOutputReason(dir: string, repoRoot: string, home: string): string | null {
  // macOS volumes are case-insensitive by default: ~/documents IS ~/Documents. Compare case-insensitively.
  const within = (p: string, root: string) => {
    const a = p.toLowerCase();
    const b = root.toLowerCase();
    return a === b || a.startsWith(b + path.sep);
  };
  if (within(dir, repoRoot)) return 'inside the repository';
  const synced = [
    path.join(home, 'Documents'),
    path.join(home, 'Desktop'),
    path.join(home, 'Library', 'Mobile Documents'),
    path.join(home, 'Library', 'CloudStorage'),
  ];
  for (const root of synced) if (within(dir, root)) return `inside ${root} (synced by iCloud / cloud storage)`;
  if (/(^|\/)(iCloud[^/]*|Dropbox[^/]*|OneDrive[^/]*|Google ?Drive[^/]*)(\/|$)/i.test(dir)) return 'inside a cloud-synced folder';
  return null;
}
