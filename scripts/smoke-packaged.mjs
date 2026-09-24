import { _electron as electron } from 'playwright-core';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const executablePath = resolve(process.env.MELEE_REPLAY_EXE || 'out/melee-replay-win32-x64/Melee Replay.exe');
const profile = await mkdtemp(join(tmpdir(), 'melee-replay-smoke-'));
const output = resolve('output/playwright');
await mkdir(output, { recursive: true });

const app = await electron.launch({
  executablePath,
  args: [`--user-data-dir=${profile}`],
  timeout: 90_000,
});

try {
  const page = await app.firstWindow();
  await page.getByRole('heading', { name: 'Browse replays' }).waitFor();
  await page.locator('.replay-row').first().waitFor();
  const count = await page.locator('.replay-row').count();
  if (count < 60) throw new Error(`Expected the reviewed catalog, found ${count} items`);
  await page.screenshot({ path: join(output, 'packaged-browse.png') });
  console.log(`Packaged catalog rendered ${count} items. Screenshot: ${join(output, 'packaged-browse.png')}`);

  if (process.argv.includes('--download')) {
    await page.locator('.replay-row').first().click();
    await page.getByRole('button', { name: 'Download replay' }).click();
    await page.getByRole('status').filter({ hasText: 'Replay ready.' }).waitFor({ timeout: 120_000 });
    const snapshot = await page.evaluate(() => window.melee.snapshot());
    const ready = snapshot.cards.filter((card) => card.availability === 'ready');
    if (ready.length !== 1) throw new Error(`Expected one acquired replay, found ${ready.length}`);
    console.log('Selected replay downloaded, parsed, and entered the packaged library.');
  }
  if (process.argv.includes('--download-set')) {
    const initial = await page.evaluate(() => window.melee.snapshot());
    const index = initial.cards.findIndex((card) => card.kind === 'set');
    if (index < 0) throw new Error('Reviewed set is missing');
    await page.locator('.replay-row').nth(index).click();
    await page.getByRole('button', { name: 'Download set' }).click();
    await page.getByRole('status').filter({ hasText: 'Replay ready.' }).waitFor({ timeout: 180_000 });
    const after = await page.evaluate(() => window.melee.snapshot());
    if (after.cards[index].availability !== 'ready') {
      throw new Error('Selected set did not enter the packaged library');
    }
    const other = after.cards.findIndex((card, cardIndex) => card.kind === 'set' && cardIndex !== index);
    if (other >= 0) {
      await page.locator('.replay-row').nth(other).click();
      await page.getByRole('button', { name: 'Download set' }).click();
      await page.getByRole('status').filter({ hasText: 'Replay ready.' }).waitFor({ timeout: 180_000 });
      const final = await page.evaluate(() => window.melee.snapshot());
      if (final.cards[index].availability !== 'ready' || final.cards[other].availability !== 'ready') {
        throw new Error('Shared archive did not prepare both selected sets');
      }
    }
    console.log('Selected publisher archive and reviewed members verified in the packaged app.');
  }
  if (process.argv.includes('--import-folder')) {
    const sourceFolder = resolve('data/slp');
    await app.evaluate(({ dialog }, folder) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
    }, sourceFolder);
    await page.getByRole('button', { name: 'Import folder' }).click();
    await page.getByRole('status').filter({ hasText: '60 added' }).waitFor({ timeout: 120_000 });
    const snapshot = await page.evaluate(() => window.melee.snapshot());
    if (snapshot.cards.length !== 60 || snapshot.cards.some((card) => card.availability !== 'ready')) {
      throw new Error('Import did not merge all local sample bytes with catalog cards.');
    }
    console.log('Imported all 60 local samples by reference and merged them with catalog cards.');
  }
} finally {
  await app.close();
}
