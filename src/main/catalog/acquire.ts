import { createHash, randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { createReadStream } from 'node:fs';
import { link, lstat, mkdir, open, rm } from 'node:fs/promises';
import { request } from 'node:https';
import type { IncomingMessage } from 'node:http';
import { join } from 'node:path';
import { assertApprovedUrl, CatalogValidationError } from './manifest.js';
import type { ApprovedSourceScope, AssetRecord, CuratedCatalog, SourcePolicy } from './types.js';

export type AcquisitionFailureCode =
  'cancelled' | 'source-unavailable' | 'network' | 'integrity' | 'storage';

export class CatalogAcquisitionError extends Error {
  constructor(public readonly code: AcquisitionFailureCode) {
    super({
      cancelled: 'Preparation was cancelled.',
      'source-unavailable': 'This replay is unavailable from its approved source.',
      network: 'The replay could not be downloaded. Please retry.',
      integrity: 'The downloaded replay did not pass integrity checks.',
      storage: 'The replay could not be saved. Check available storage.',
    }[code]);
    this.name = 'CatalogAcquisitionError';
  }
}

export interface AcquiredAsset { assetId: string; path: string }
export interface AcquisitionOptions {
  signal?: AbortSignal;
  onPhase?: (phase: 'preparing' | 'downloading' | 'verifying' | 'ready') => void;
}

function publicIpv4(value: string): boolean {
  const parts = value.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return false;
  const [a, b, c] = parts;
  return a > 0 && a < 224 && a !== 10 && a !== 127 &&
    !(a === 100 && b >= 64 && b <= 127) &&
    !(a === 169 && b === 254) && !(a === 172 && b >= 16 && b <= 31) &&
    !(a === 192 && (b === 168 || b === 0 || (b === 0 && c === 2))) &&
    !(a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) &&
    !(a === 203 && b === 0 && c === 113);
}

async function publicAddress(hostname: string): Promise<string> {
  const answers = await lookup(hostname, { all: true });
  const ipv4 = answers.filter((answer) => answer.family === 4);
  if (!ipv4.length || ipv4.some((answer) => !publicIpv4(answer.address))) {
    throw new CatalogAcquisitionError('source-unavailable');
  }
  return ipv4[0].address;
}

function checkedRequest(url: URL, signal?: AbortSignal): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    void publicAddress(url.hostname).then((address) => {
      if (signal?.aborted) throw new CatalogAcquisitionError('cancelled');
      const req = request(url, {
        method: 'GET',
        signal,
        headers: { Accept: 'application/octet-stream', 'User-Agent': 'MeleeReplay/1' },
        lookup: (_hostname, lookupOptions, callback) => {
          if (lookupOptions.all) callback(null, [{ address, family: 4 }]);
          else callback(null, address, 4);
        },
        maxHeaderSize: 16 * 1024,
      }, resolve);
      req.setTimeout(30_000, () => req.destroy(new Error('timeout')));
      req.on('error', reject);
      req.end();
    }).catch(reject);
  });
}

interface Response { stream: IncomingMessage; retryAfterMs: number }
async function fetchApproved(asset: AssetRecord, source: SourcePolicy,
  approved: ApprovedSourceScope, signal?: AbortSignal): Promise<Response> {
  let url: URL;
  try { url = assertApprovedUrl(asset.fetchUrl, source, approved); }
  catch (error) {
    if (error instanceof CatalogValidationError) throw new CatalogAcquisitionError('source-unavailable');
    throw error;
  }
  for (let redirects = 0; redirects <= 5; redirects++) {
    const stream = await checkedRequest(url, signal);
    const status = stream.statusCode ?? 0;
    if ([301, 302, 303, 307, 308].includes(status)) {
      const location = stream.headers.location;
      stream.resume();
      if (!location || redirects === 5) throw new CatalogAcquisitionError('source-unavailable');
      let next: URL;
      try { next = new URL(location, url); } catch { throw new CatalogAcquisitionError('source-unavailable'); }
      try { url = assertApprovedUrl(next.toString(), source, approved, true); }
      catch (error) {
        if (error instanceof CatalogValidationError) throw new CatalogAcquisitionError('source-unavailable');
        throw error;
      }
      continue;
    }
    if (status !== 200) {
      stream.resume();
      if ([408, 429, 500, 502, 503, 504].includes(status)) {
        const header = stream.headers['retry-after'];
        const raw = Array.isArray(header) ? header[0] : header;
        const seconds = raw && /^\d+$/.test(raw) ? Number(raw) * 1000 : NaN;
        const date = raw ? Date.parse(raw) - Date.now() : NaN;
        const retryAfterMs = Number.isFinite(seconds) ? seconds : Number.isFinite(date) ? date : 0;
        return { stream, retryAfterMs: Math.max(0, Math.min(retryAfterMs, 30_000)) };
      }
      throw new CatalogAcquisitionError('source-unavailable');
    }
    const length = stream.headers['content-length'];
    if (length && (!/^\d+$/.test(length) || Number(length) !== asset.byteSize)) {
      stream.destroy();
      throw new CatalogAcquisitionError('integrity');
    }
    return { stream, retryAfterMs: 0 };
  }
  throw new CatalogAcquisitionError('source-unavailable');
}

async function verifiedExisting(path: string, asset: AssetRecord, signal?: AbortSignal): Promise<boolean> {
  let info;
  try { info = await lstat(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
  if (!info.isFile() || info.size !== asset.byteSize) throw new CatalogAcquisitionError('integrity');
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) {
    if (signal?.aborted) throw new CatalogAcquisitionError('cancelled');
    hash.update(chunk);
  }
  if (hash.digest('hex') !== asset.sha256) throw new CatalogAcquisitionError('integrity');
  return true;
}

const delay = (ms: number, signal?: AbortSignal): Promise<void> => new Promise((resolve, reject) => {
  if (signal?.aborted) { reject(new CatalogAcquisitionError('cancelled')); return; }
  const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
  const abort = () => { clearTimeout(timer); reject(new CatalogAcquisitionError('cancelled')); };
  signal?.addEventListener('abort', abort, { once: true });
});

async function downloadOne(asset: AssetRecord, source: SourcePolicy,
  approved: ApprovedSourceScope, dir: string, options: AcquisitionOptions,
  retryBudget: { remaining: number }): Promise<AcquiredAsset> {
  const path = join(dir, `${asset.sha256}.${asset.format}`);
  if (await verifiedExisting(path, asset, options.signal)) {
    if (options.signal?.aborted) throw new CatalogAcquisitionError('cancelled');
    return { assetId: asset.assetId, path };
  }
  let attempt = 0;
  for (;;) {
    if (options.signal?.aborted) throw new CatalogAcquisitionError('cancelled');
    const temp = join(dir, `.partial-${randomUUID()}`);
    try {
      const { stream, retryAfterMs } = await fetchApproved(asset, source, approved, options.signal);
      if (stream.statusCode !== 200) {
        if (retryBudget.remaining <= 0) throw new CatalogAcquisitionError('network');
        retryBudget.remaining--;
        await delay(Math.max(retryAfterMs, Math.min(1000 * 2 ** attempt++, 8000)), options.signal);
        continue;
      }
      let file;
      try { file = await open(temp, 'wx', 0o600); }
      catch { stream.destroy(); throw new CatalogAcquisitionError('storage'); }
      let total = 0;
      const hash = createHash('sha256');
      try {
        for await (const chunk of stream) {
          if (options.signal?.aborted) throw new CatalogAcquisitionError('cancelled');
          total += chunk.length;
          if (total > asset.byteSize) throw new CatalogAcquisitionError('integrity');
          hash.update(chunk);
          let offset = 0;
          while (offset < chunk.length) {
            const { bytesWritten } = await file.write(chunk, offset);
            if (bytesWritten === 0) throw new CatalogAcquisitionError('storage');
            offset += bytesWritten;
          }
        }
        await file.sync();
      } catch (error) {
        if (['ENOSPC', 'EDQUOT', 'EACCES', 'EPERM', 'EIO'].includes((error as NodeJS.ErrnoException).code ?? '')) {
          throw new CatalogAcquisitionError('storage');
        }
        throw error;
      } finally { await file.close(); }
      if (total !== asset.byteSize || hash.digest('hex') !== asset.sha256) {
        throw new CatalogAcquisitionError('integrity');
      }
      try { await link(temp, path); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST' ||
            !(await verifiedExisting(path, asset, options.signal))) throw error;
      }
      return { assetId: asset.assetId, path };
    } catch (error) {
      if (options.signal?.aborted) throw new CatalogAcquisitionError('cancelled');
      if (error instanceof CatalogAcquisitionError) throw error;
      if (retryBudget.remaining-- <= 0) throw new CatalogAcquisitionError('network');
      await delay(Math.min(1000 * 2 ** attempt++, 8000), options.signal);
    } finally { await rm(temp, { force: true }); }
  }
}

export async function acquireSelectedItem(
  catalog: CuratedCatalog,
  itemId: string,
  managedDirectory: string,
  approvedSources: readonly ApprovedSourceScope[],
  options: AcquisitionOptions = {},
): Promise<AcquiredAsset[]> {
  const item = catalog.items.find((entry) => entry.itemId === itemId);
  if (!item) throw new CatalogAcquisitionError('source-unavailable');
  const replayIds = item.kind === 'standalone' ? [item.replayId] : item.segments.map((s) => s.replayId);
  const replayMap = new Map(catalog.replays.map((r) => [r.replayId, r]));
  const assetMap = new Map(catalog.assets.map((a) => [a.assetId, a]));
  const sourceMap = new Map(catalog.sources.map((s) => [s.sourceId, s]));
  const approvalMap = new Map(approvedSources.map((s) => [s.sourceId, s]));
  const assets = [...new Set(replayIds.map((id) => replayMap.get(id)!.assetId))].map((id) => assetMap.get(id)!);
  options.onPhase?.('preparing');
  const dir = join(managedDirectory, 'catalog-assets');
  try {
    await mkdir(dir, { recursive: true });
    if (!(await lstat(dir)).isDirectory()) throw new CatalogAcquisitionError('storage');
  } catch { throw new CatalogAcquisitionError('storage'); }
  const results: AcquiredAsset[] = new Array(assets.length);
  const budget = { remaining: 2 };
  let next = 0;
  let downloading = false;
  const controller = new AbortController();
  const cancel = () => controller.abort();
  options.signal?.addEventListener('abort', cancel, { once: true });
  if (options.signal?.aborted) controller.abort();
  const workingOptions = { ...options, signal: controller.signal };
  const worker = async (): Promise<void> => {
    while (next < assets.length && !controller.signal.aborted) {
      const index = next++;
      const asset = assets[index];
      const source = sourceMap.get(asset.sourceId)!;
      const approval = approvalMap.get(asset.sourceId);
      if (!approval || source.eligibility !== 'eligible') throw new CatalogAcquisitionError('source-unavailable');
      if (!downloading) { downloading = true; options.onPhase?.('downloading'); }
      try { results[index] = await downloadOne(asset, source, approval, dir, workingOptions, budget); }
      catch (error) { controller.abort(); throw error; }
    }
  };
  const settled = await Promise.allSettled(Array.from({ length: Math.min(2, assets.length) }, worker));
  options.signal?.removeEventListener('abort', cancel);
  const failures = settled.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
  if (failures.length) {
    const error = failures.map((failure) => failure.reason).find((reason) =>
      reason instanceof CatalogAcquisitionError && reason.code !== 'cancelled') ?? failures[0].reason;
    if (error instanceof CatalogAcquisitionError) throw error;
    throw new CatalogAcquisitionError(options.signal?.aborted ? 'cancelled' : 'storage');
  }
  if (controller.signal.aborted) throw new CatalogAcquisitionError('cancelled');
  options.onPhase?.('verifying');
  options.onPhase?.('ready');
  return results;
}
