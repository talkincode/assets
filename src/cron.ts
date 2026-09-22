/**
 * Hourly lifecycle sweep.
 *
 * Reads already refuse to serve an expired or deleted asset, so this job is
 * about storage and housekeeping rather than correctness: it frees the bytes,
 * records that they are gone, and keeps the bookkeeping tables bounded.
 */

import { assetCacheUrls, purgeUrls } from './cache';
import { all, getNumberSetting, run, type AssetRow } from './db';

const BATCH = 400;

export interface SweepResult {
  expired: number;
  purged: number;
  blocksCleared: number;
  auditPruned: number;
}

export async function sweep(env: Env, exec: ExecutionContext, now = Date.now()): Promise<SweepResult> {
  const result: SweepResult = { expired: 0, purged: 0, blocksCleared: 0, auditPruned: 0 };
  const toPurge: AssetRow[] = [];

  // 1. Assets whose TTL ran out: tombstone them and drop the bytes right away.
  const expired = await all<AssetRow>(
    env,
    `SELECT * FROM assets
     WHERE deleted_at IS NULL AND purged_at IS NULL AND expires_at IS NOT NULL AND expires_at <= ?
     ORDER BY expires_at LIMIT ?`,
    now,
    BATCH,
  );
  for (const asset of expired) {
    await run(env, 'UPDATE assets SET deleted_at = ?, delete_reason = ? WHERE hash = ?', now, 'expired', asset.hash);
    toPurge.push(asset);
  }
  result.expired = expired.length;

  // 2. Deleted assets keep their bytes for a while so a mistake is recoverable.
  const retentionDays = await getNumberSetting(env, 'trash_retention_days', Number(env.TRASH_RETENTION_DAYS) || 7);
  const trashCutoff = now - retentionDays * 86_400_000;
  const trash = await all<AssetRow>(
    env,
    `SELECT * FROM assets
     WHERE deleted_at IS NOT NULL AND purged_at IS NULL AND deleted_at <= ?
     ORDER BY deleted_at LIMIT ?`,
    trashCutoff,
    BATCH,
  );
  toPurge.push(...trash);

  if (toPurge.length > 0) {
    const keys = toPurge.map((asset) => asset.object_key);
    // R2 takes bulk deletes in chunks of 1000; BATCH keeps us well under that.
    await env.BUCKET.delete(keys);
    await env.DB.prepare(
      `UPDATE assets SET purged_at = ? WHERE hash IN (${toPurge.map(() => '?').join(',')})`,
    )
      .bind(now, ...toPurge.map((asset) => asset.hash))
      .run();
    result.purged = toPurge.length;

    const urls = toPurge.flatMap((asset) => assetCacheUrls(env, asset.hash, asset.filename));
    if (urls.length > 0) await purgeUrls(env, exec, urls);
  }

  // 3. Blocks expire on their own; this only stops the table growing forever.
  const cleared = await run(env, 'DELETE FROM blocked_sources WHERE blocked_until < ?', now - 30 * 86_400_000);
  result.blocksCleared = cleared.meta.changes ?? 0;

  // 4. Keep the audit trail useful without letting it grow without bound.
  const pruned = await run(env, 'DELETE FROM audit_log WHERE at < ?', now - 180 * 86_400_000);
  result.auditPruned = pruned.meta.changes ?? 0;

  return result;
}
