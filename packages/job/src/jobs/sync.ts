import { createSupabaseClient } from '../lib/supabase.js';
import type { Database } from '@haraka/shared';

type RunRow = Database['public']['Tables']['run']['Row'];

export async function runSync() {
  const supabase = createSupabaseClient();
  const { data: run, error } = await supabase
    .from('run')
    .insert({ triggered_by: process.env.TRIGGER || 'manual' })
    .select()
    .single<RunRow>();
  if (error || !run) throw new Error(`Failed to create run: ${error?.message}`);
  console.log(`Run created: ${run.id}`);

  try {
    // Phase 1 で実装:
    // 1. KECAK取得
    // 2. DB照合
    // 3. 買取下限計算
    // 4. PreparedCard保存
    throw new Error('Not implemented yet - Phase 1');
  } catch (err) {
    await supabase.from('run').update({ status: 'failed', error_message: (err as Error).message }).eq('id', run.id);
    throw err;
  }
}
