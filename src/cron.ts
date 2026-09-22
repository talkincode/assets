/**
 * Hourly lifecycle sweep.
 *
 * Link expiry is enforced on read (410); this job only frees storage for
 * manually deleted assets after the trash retention window, and keeps
 * bookkeeping tables bounded.
 */

import { assetCacheUrls, purgeUrls } from './cache';
import { all, getNumberSetting, run, type AssetRow } from './db';

const BATCH = 400;

export interface SweepResult {
  purged: number;
  blocksCleared: number;
  auditPruned: number;
}

export async function sweep(env: Env, exec: ExecutionContext, now = Date.now()): Promise<SweepResult> {
  const result: SweepResult = { purged: 0, blocksCleared: 0, auditPruned: 0 };

  // Deleted assets keep their bytes for a while so a mistake is recoverable.
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

  if (trash.length > 0) {
    const keys = trash.map((asset) => asset.object_key);
    await env.BUCKET.delete(keys);
    await env.DB.prepare(
      `UPDATE assets SET purged_at = ? WHERE hash IN (${trash.map(() => '?').join(',')})`,
    )
      .bind(now, ...trash.map((asset) => asset.hash))
      .run();
    result.purged = trash.length;

    // Purge every share-link cache entry that pointed at these assets.
    const linkHashes = await all<{ hash: string; filename: string }>(
      env,
      `SELECT links.hash AS hash, assets.filename AS filename
       FROM links JOIN assets ON assets.hash = links.asset_hash
       WHERE links.asset_hash IN (${trash.map(() => '?').join(',')})`,
      ...trash.map((asset) => asset.hash),
    );
    const urls = linkHashes.flatMap((row) => assetCacheUrls(env, row.hash, row.filename));
    if (urls.length > 0) await purgeUrls(env, exec, urls);
  }

  const cleared = await run(env, 'DELETE FROM blocked_sources WHERE blocked_until < ?', now - 7 * 86_400_000);
  result.blocksCleared = cleared.meta.changes ?? 0;

  const pruned = await run(env, 'DELETE FROM audit_log WHERE at < ?', now - 180 * 86_400_000);
  result.auditPruned = pruned.meta.changes ?? 0;

  return result;
}
