import { createClient, SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@haraka/shared';

export function createSupabaseClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');
  return createClient<Database>(url, key);
}

/**
 * Secret Manager から Supabase 認証情報を取得してクライアントを作成する。
 * 環境変数が未設定の場合のフォールバック用。
 */
export async function createSupabaseClientFromSecrets(): Promise<SupabaseClient<Database>> {
  // 環境変数があればそちらを優先
  if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return createSupabaseClient();
  }

  const { getSecret } = await import('./secret-manager.js');
  const [url, key] = await Promise.all([
    getSecret('supabase-url'),
    getSecret('supabase-service-role-key'),
  ]);
  return createClient<Database>(url, key);
}
