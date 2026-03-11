/**
 * バッチ挿入ヘルパー
 *
 * 大量データを BATCH_SIZE 件ずつ分割して Supabase に insert する
 */

import { createSupabaseClient } from './supabase.js';

const BATCH_SIZE = 500;

/**
 * 大量データをバッチに分割して insert する
 */
export async function batchInsert<T extends Record<string, unknown>>(
  supabase: ReturnType<typeof createSupabaseClient>,
  table: string,
  rows: T[],
): Promise<void> {
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    const { error } = await (supabase.from(table) as ReturnType<ReturnType<typeof createSupabaseClient>['from']>)
      .insert(batch);
    if (error) throw new Error(`${table} insert failed (batch ${Math.floor(i / BATCH_SIZE) + 1}): ${error.message}`);
  }
}
