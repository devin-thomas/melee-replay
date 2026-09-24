import { lstat, readdir, realpath, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export interface ManagedStorage {
  totalBytes: number;
  downloadCacheBytes: number;
}

function samePath(left: string, right: string): boolean {
  const normalized = (path: string) => process.platform === 'win32'
    ? resolve(path).toLocaleLowerCase('en-US') : resolve(path);
  return normalized(left) === normalized(right);
}

async function regularDirectory(path: string): Promise<boolean> {
  let info;
  try { info = await lstat(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error('Managed storage directory is not safe to access.');
  }
  return true;
}

async function filesIn(directory: string): Promise<Array<{ name: string; size: number }>> {
  if (!(await regularDirectory(directory))) return [];
  const files: Array<{ name: string; size: number }> = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isFile() || entry.isSymbolicLink()) continue;
    const info = await lstat(join(directory, entry.name));
    if (info.isFile() && !info.isSymbolicLink()) files.push({ name: entry.name, size: info.size });
  }
  return files;
}

export async function managedStorage(
  managedRoot: string,
  approvedArchiveNames: ReadonlySet<string>,
  protectedPaths: readonly string[],
): Promise<ManagedStorage> {
  if (!(await regularDirectory(managedRoot))) return { totalBytes: 0, downloadCacheBytes: 0 };
  const catalogDir = join(managedRoot, 'catalog-assets');
  const reporterDir = join(managedRoot, 'reporter');
  const [catalogFiles, reporterFiles] = await Promise.all([filesIn(catalogDir), filesIn(reporterDir)]);
  const totalBytes = [...catalogFiles, ...reporterFiles].reduce((sum, file) => sum + file.size, 0);
  const downloadCacheBytes = catalogFiles.reduce((sum, file) => {
    const path = join(catalogDir, file.name);
    return sum + (approvedArchiveNames.has(file.name) && /^[a-f0-9]{64}\.zip$/.test(file.name) &&
      !protectedPaths.some((protectedPath) => samePath(protectedPath, path)) ? file.size : 0);
  }, 0);
  return { totalBytes, downloadCacheBytes };
}

export async function clearDownloadCache(
  managedRoot: string,
  approvedArchiveNames: ReadonlySet<string>,
  protectedPaths: readonly string[],
): Promise<number> {
  if (!(await regularDirectory(managedRoot))) return 0;
  const directory = join(managedRoot, 'catalog-assets');
  if (!(await regularDirectory(directory))) return 0;
  let freedBytes = 0;
  for (const file of await filesIn(directory)) {
    if (!approvedArchiveNames.has(file.name) || !/^[a-f0-9]{64}\.zip$/.test(file.name)) continue;
    const path = join(directory, file.name);
    if (protectedPaths.some((protectedPath) => samePath(protectedPath, path))) continue;
    const currentDirectory = await realpath(directory);
    if (!samePath(currentDirectory, directory)) throw new Error('Managed storage directory changed during cleanup.');
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size !== file.size) {
      throw new Error('Download cache changed during cleanup.');
    }
    await rm(path);
    freedBytes += file.size;
  }
  return freedBytes;
}
