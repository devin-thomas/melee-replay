import { _electron as electron } from 'playwright-core';
import { mkdtemp, mkdir, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const executablePath = resolve(process.env.MELEE_REPLAY_EXE || 'out/melee-replay-win32-x64/Melee Replay.exe');
const reusableProfile = process.env.MELEE_REPLAY_SMOKE_PROFILE;
const profile = reusableProfile ? resolve(reusableProfile) : await mkdtemp(join(tmpdir(), 'melee-replay-smoke-'));
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
  if (process.argv.includes('--storage')) {
    const snapshot = await page.evaluate(() => window.melee.snapshot());
    if (!Number.isFinite(snapshot.managedStorage.totalBytes) ||
        !Number.isFinite(snapshot.managedStorage.downloadCacheBytes) ||
        snapshot.managedStorage.totalBytes < snapshot.managedStorage.downloadCacheBytes) {
      throw new Error('Packaged managed storage report is invalid.');
    }
    await page.getByRole('button', { name: 'Setup' }).click();
    await page.getByRole('region', { name: 'Managed storage' }).waitFor();
    await page.getByRole('button', { name: 'Clear download cache' }).waitFor();
    console.log('Packaged Setup rendered aggregate managed storage and cache controls.');
  }

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
    const indices = initial.cards.flatMap((card, index) => card.kind === 'set' ? [index] : []);
    const manifest = JSON.parse(await readFile(resolve('data/catalog-v1.json'), 'utf8'));
    if (indices.length !== manifest.items.filter((item) => item.kind === 'set').length) {
      throw new Error('Reviewed set batch is incomplete');
    }
    for (const index of indices) {
      await page.locator('.replay-row').nth(index).click();
      await page.getByRole('button', { name: 'Download set' }).click();
      await page.getByRole('status').filter({ hasText: 'Replay ready.' }).waitFor({ timeout: 180_000 });
      const after = await page.evaluate(() => window.melee.snapshot());
      if (after.cards[index].availability !== 'ready') throw new Error('Selected set did not enter the packaged library');
    }
    const final = await page.evaluate(() => window.melee.snapshot());
    if (indices.some((index) => final.cards[index].availability !== 'ready')) {
      throw new Error('A reviewed set is missing after shared-archive preparation');
    }
    console.log('All reviewed sets verified and prepared through the packaged app.');
  }
  if (process.argv.includes('--download-short-set')) {
    const manifest = JSON.parse(await readFile(resolve('data/catalog-v1.json'), 'utf8'));
    const item = manifest.items.find((entry) => entry.kind === 'set' && entry.bestOf === 3);
    if (!item) throw new Error('Reviewed short-format set is missing.');
    const before = await page.evaluate(() => window.melee.snapshot());
    const index = before.cards.findIndex((card) => card.id === item.itemId);
    if (index < 0) throw new Error('Short-format set is not in the packaged catalog.');
    if (before.cards[index].availability !== 'ready') {
      await page.locator('.replay-row').nth(index).click();
      await page.getByRole('button', { name: 'Download set' }).click();
      await page.getByRole('status').filter({ hasText: 'Replay ready.' }).waitFor({ timeout: 180_000 });
    }
    const after = await page.evaluate(() => window.melee.snapshot());
    if (after.cards[index].availability !== 'ready') throw new Error('Short-format set was not prepared.');
    console.log('Packaged short-format set acquired and validated.');
  }
  if (process.argv.includes('--import-folder')) {
    const sourceFolder = resolve('data/slp');
    await app.evaluate(({ dialog }, folder) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
    }, sourceFolder);
    await page.getByRole('button', { name: 'Import folder' }).click();
    await page.getByRole('status').filter({ hasText: '60 added' }).waitFor({ timeout: 120_000 });
    const snapshot = await page.evaluate(() => window.melee.snapshot());
    const standalone = snapshot.cards.filter((card) => card.kind === 'standalone');
    if (standalone.length !== 60 || standalone.some((card) => card.availability !== 'ready')) {
      throw new Error('Import did not merge all local sample bytes with catalog cards.');
    }
    console.log('Imported all 60 local samples by reference and merged them with catalog cards.');
  }
  if (process.argv.includes('--import-package')) {
    const archive = resolve('output/playwright/reporter-smoke.zip');
    await app.evaluate(({ dialog }, packagePath) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [packagePath] });
    }, archive);
    await page.getByRole('button', { name: 'Import Reporter package' }).click();
    await page.getByRole('status').filter({ hasText: /added|already in library/ }).waitFor({ timeout: 120_000 });
    const after = await page.evaluate(() => window.melee.snapshot());
    if (!after.cards.some((card) => card.availability === 'ready')) {
      throw new Error('Reporter package replay was not imported.');
    }
    console.log('Packaged Reporter ZIP imported a verified standalone replay.');
  }
  if (process.argv.includes('--practice-stop') || process.argv.includes('--practice-natural')) {
    await page.evaluate(() => window.melee.recheckSetup());
    const sourceFolder = resolve('data/slp');
    const candidates = (await readdir(sourceFolder)).filter((name) => name.endsWith('.slp'));
    const sizes = await Promise.all(candidates.map(async (name) => ({
      path: join(sourceFolder, name), size: (await stat(join(sourceFolder, name))).size,
    })));
    sizes.sort((a, b) => a.size - b.size);
    if (!sizes.length) throw new Error('No local replay is available for packaged practice smoke.');
    await app.evaluate(({ dialog }, replayPath) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [replayPath] });
    }, sizes[0].path);
    await page.getByRole('button', { name: 'Import files' }).click();
    await page.getByRole('status').filter({ hasText: /added|already in library/ }).waitFor({ timeout: 120_000 });
    const imported = await page.evaluate(() => window.melee.snapshot());
    const card = imported.cards.find((entry) => entry.availability === 'ready');
    if (!card) throw new Error('Imported replay is not ready.');
    await page.evaluate((itemId) => window.melee.startPractice(itemId), card.id);
    let phase = '';
    const deadline = Date.now() + 240_000;
    while (Date.now() < deadline) {
      const current = await page.evaluate(() => window.melee.snapshot());
      phase = current.session.phase;
      if (phase === 'playing' || phase === 'failed' || phase === 'completed') break;
      await page.waitForTimeout(250);
    }
    if (phase !== 'playing') throw new Error(`Packaged playback did not start: ${phase}`);
    if (process.argv.includes('--practice-stop')) {
      const stopped = await page.evaluate(() => window.melee.sessionCommand('stop'));
      if (stopped.phase !== 'interrupted') throw new Error('Stop did not interrupt packaged playback.');
      const history = await page.evaluate(() => window.melee.snapshot());
      if (history.history[0]?.status !== 'interrupted') throw new Error('Interrupted attempt was not saved.');
      console.log('Packaged playback started, stopped, and saved interruption without completion.');
    } else {
      while (Date.now() < deadline) {
        const current = await page.evaluate(() => window.melee.snapshot());
        phase = current.session.phase;
        if (phase === 'completed' || phase === 'failed') break;
        await page.waitForTimeout(500);
      }
      if (phase !== 'completed') throw new Error(`Packaged playback did not complete naturally: ${phase}`);
      const history = await page.evaluate(() => window.melee.snapshot());
      if (history.history[0]?.status !== 'completed') throw new Error('Completed attempt was not saved.');
      console.log('Packaged playback completed naturally and saved history.');
    }
  }
  if (process.argv.includes('--practice-set')) {
    await page.evaluate(() => window.melee.recheckSetup());
    const initial = await page.evaluate(() => window.melee.snapshot());
    const card = initial.cards.find((entry) => entry.kind === 'set' && entry.availability === 'ready');
    if (!card) throw new Error('No verified set is prepared in this smoke profile.');
    await page.evaluate((itemId) => window.melee.startPractice(itemId), card.id);
    const deadline = Date.now() + 480_000;
    let current;
    while (Date.now() < deadline) {
      current = await page.evaluate(() => window.melee.snapshot());
      if (current.session.phase === 'intermission-countdown' || current.session.phase === 'failed') break;
      await page.waitForTimeout(500);
    }
    if (current?.session.phase !== 'intermission-countdown') {
      throw new Error(`Verified set did not reach intermission: ${current?.session.phase}`);
    }
    const held = await page.evaluate(() => window.melee.sessionCommand('hold'));
    if (held.phase !== 'intermission-held') throw new Error('Hold did not pause intermission.');
    await page.waitForTimeout(1500);
    if ((await page.evaluate(() => window.melee.snapshot())).session.phase !== 'intermission-held') {
      throw new Error('Held intermission advanced unexpectedly.');
    }
    await page.evaluate(() => window.melee.sessionCommand('next'));
    while (Date.now() < deadline) {
      current = await page.evaluate(() => window.melee.snapshot());
      if (current.session.phase === 'playing' || current.session.phase === 'failed') break;
      await page.waitForTimeout(250);
    }
    if (current?.session.phase !== 'playing') throw new Error('Next did not start playback.');
    const stopped = await page.evaluate(() => window.melee.sessionCommand('stop'));
    if (stopped.phase !== 'interrupted') throw new Error('Stop did not interrupt the verified set.');
    console.log('Packaged verified set played through intermission; Hold, Next, and Stop behaved correctly.');
  }
  const fullSetArg = process.argv.find((arg) => arg.startsWith('--practice-set-complete='));
  if (fullSetArg) {
    await page.evaluate(() => window.melee.recheckSetup());
    const mode = fullSetArg.slice('--practice-set-complete='.length);
    if (!['bo3', 'bo5', 'long'].includes(mode)) throw new Error('Unknown set smoke mode.');
    const manifest = JSON.parse(await readFile(resolve('data/catalog-v1.json'), 'utf8'));
    const ready = new Set((await page.evaluate(() => window.melee.snapshot())).cards
      .filter((card) => card.kind === 'set' && card.availability === 'ready').map((card) => card.id));
    const item = manifest.items.find((entry) => entry.kind === 'set' && ready.has(entry.itemId) &&
      (mode === 'long' ? entry.segments.length > (entry.bestOf === 3 ? 2 : 3) :
        entry.bestOf === Number(mode.slice(2))));
    if (!item) throw new Error('No prepared verified set matches this acceptance mode.');
    await page.evaluate((itemId) => window.melee.startPractice(itemId), item.itemId);
    const deadline = Date.now() + 1_800_000;
    let phase = '';
    while (Date.now() < deadline) {
      const current = await page.evaluate(() => window.melee.snapshot());
      phase = current.session.phase;
      if (phase === 'completed' || phase === 'failed' || phase === 'interrupted') break;
      if (phase === 'intermission-countdown') await page.evaluate(() => window.melee.sessionCommand('next'));
      else await page.waitForTimeout(500);
    }
    if (phase !== 'completed') throw new Error(`Full verified set did not complete: ${phase}`);
    const history = await page.evaluate(() => window.melee.snapshot());
    if (history.history[0]?.status !== 'completed') throw new Error('Full set completion was not saved.');
    if (process.argv.includes('--practice-repeat')) {
      const repeated = await page.evaluate(() => window.melee.sessionCommand('practice-again'));
      if (repeated.phase !== 'starting' && repeated.phase !== 'playing') {
        throw new Error('Repeated practice did not restart playback.');
      }
      if (repeated.observedScore?.some((score) => score !== 0)) {
        throw new Error('Repeated practice retained the previous score.');
      }
      let repeatPhase = repeated.phase;
      const repeatDeadline = Date.now() + 120_000;
      while (repeatPhase !== 'playing' && Date.now() < repeatDeadline) {
        repeatPhase = (await page.evaluate(() => window.melee.snapshot())).session.phase;
        await page.waitForTimeout(250);
      }
      if (repeatPhase !== 'playing') throw new Error('Repeated practice did not begin playback.');
      await page.evaluate(() => window.melee.sessionCommand('stop'));
      const repeatedHistory = await page.evaluate(() => window.melee.snapshot());
      if (repeatedHistory.history[0]?.status !== 'interrupted' ||
          repeatedHistory.history[1]?.status !== 'completed') {
        throw new Error('Repeated practice did not preserve both attempts.');
      }
      console.log('Repeated practice reset its reveal state and retained both attempts.');
    }
    await page.evaluate(() => window.melee.sessionCommand('leave'));
    console.log('Packaged verified set completed with natural evidence for every game.');
  }
} finally {
  try {
    await app.close();
  } finally {
    if (!reusableProfile) await rm(profile, { recursive: true, force: true });
  }
}
