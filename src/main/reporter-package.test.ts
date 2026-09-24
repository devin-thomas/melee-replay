import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractReporterPackage } from './reporter-package';

interface FixtureEntry {
  name: string;
  data: string;
  declaredSize?: number;
  externalAttributes?: number;
}

function zip(entries: FixtureEntry[]): Buffer {
  const records: Buffer[] = [];
  const directory: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const data = Buffer.from(entry.data, 'utf8');
    const size = entry.declaredSize ?? data.length;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt32LE(size, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    records.push(local, name, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x0314, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt32LE(size, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(entry.externalAttributes ?? 0, 38);
    central.writeUInt32LE(offset, 42);
    directory.push(central, name);
    offset += local.length + name.length + data.length;
  }
  const centralSize = directory.reduce((sum, block) => sum + block.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...records, ...directory, end]);
}

const owned: string[] = [];
async function fixture(entries: FixtureEntry[]): Promise<{ archive: string; managed: string }> {
  const root = await mkdtemp(join(tmpdir(), 'melee-reporter-test-'));
  owned.push(root);
  const archive = join(root, 'source.zip');
  await writeFile(archive, zip(entries));
  return { archive, managed: join(root, 'managed') };
}

afterEach(async () => {
  for (const root of owned.splice(0)) await rm(root, { recursive: true, force: true });
});

describe('Replay Reporter package extraction', () => {
  it('imports only neutral, content-addressed working copies', async () => {
    const { archive, managed } = await fixture([
      { name: 'context.json', data: JSON.stringify({ scores: [1, 2] }) },
      { name: 'games/private-name.slp', data: 'sample replay bytes' },
    ]);
    const result = await extractReporterPackage(archive, managed);
    expect(result).toHaveLength(1);
    expect(result[0].path).toMatch(/[a-f0-9]{64}\.slp$/);
    expect(result[0].archivePath).toBe(archive);
    expect(result[0].entryPath).toBe('games/private-name.slp');
    expect(await readFile(result[0].path, 'utf8')).toBe('sample replay bytes');
    expect(await readdir(managed)).toHaveLength(1);
  });

  it.each([
    ['traversal', '../escape.slp'],
    ['drive path', 'C:/escape.slp'],
    ['backslash', 'games\\escape.slp'],
    ['duplicate normalized path', 'GAMES/A.slp'],
    ['Unicode traversal', '\uff0e\uff0e/escape.slp'],
  ])('rejects %s before extraction', async (_description, badPath) => {
    const entries = [
      { name: 'context.json', data: '{}' },
      { name: 'games/a.slp', data: 'first' },
      { name: badPath, data: 'second' },
    ];
    const { archive, managed } = await fixture(entries);
    await expect(extractReporterPackage(archive, managed)).rejects.toThrow();
    expect(await readdir(managed)).toHaveLength(0);
  });

  it('rejects symlink and junction members before extraction', async () => {
    const symlink = await fixture([
      { name: 'context.json', data: '{}' },
      { name: 'game.slp', data: 'target', externalAttributes: 0xa0000000 },
    ]);
    await expect(extractReporterPackage(symlink.archive, symlink.managed)).rejects.toThrow();
    expect(await readdir(symlink.managed)).toHaveLength(0);
    const junction = await fixture([
      { name: 'context.json', data: '{}' },
      { name: 'game.slp', data: 'target', externalAttributes: 0x400 },
    ]);
    await expect(extractReporterPackage(junction.archive, junction.managed)).rejects.toThrow();
    expect(await readdir(junction.managed)).toHaveLength(0);
  });

  it('rejects oversized declared metadata before extraction', async () => {
    const huge = await fixture([
      { name: 'context.json', data: '{}', declaredSize: 256 * 1024 + 1 },
      { name: 'game.slp', data: 'replay' },
    ]);
    await expect(extractReporterPackage(huge.archive, huge.managed)).rejects.toThrow();
    expect(await readdir(huge.managed)).toHaveLength(0);
    const hugeReplay = await fixture([
      { name: 'context.json', data: '{}' },
      { name: 'game.slp', data: 'replay', declaredSize: 256 * 1024 * 1024 + 1 },
    ]);
    await expect(extractReporterPackage(hugeReplay.archive, hugeReplay.managed)).rejects.toThrow();
    expect(await readdir(hugeReplay.managed)).toHaveLength(0);
  });

  it('rejects invalid context without publishing a replay', async () => {
    const { archive, managed } = await fixture([
      { name: 'game.slp', data: 'replay' },
      { name: 'context.json', data: '{' },
    ]);
    await expect(extractReporterPackage(archive, managed)).rejects.toThrow();
    expect(await readdir(managed)).toHaveLength(0);
  });
});
