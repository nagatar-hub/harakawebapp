/**
 * Sync ジョブ — Phase 1 メインオーケストレーター
 *
 * 処理フロー:
 * 1. Run レコード作成
 * 2. OAuth credentials 取得
 * 3. KECAK スプレッドシートから 3 シート取得 → raw_import 保存
 * 4. Haraka DB スプレッドシートから 3 シート取得 → LookupMap 構築
 * 5. PreparedCard 変換 → prepared_card 保存
 * 6. Run 統計更新
 */

import { createSupabaseClient } from '../lib/supabase.js';
import { refreshAccessToken, fetchSheetValues } from '../lib/google-sheets.js';
import { parseKecakRows } from '../lib/kecak-parser.js';
import { buildLookupMap } from '../lib/db-lookup.js';
import { prepareCards } from '../lib/prepare-cards.js';
import type { Database, Franchise } from '@haraka/shared';
import { FRANCHISES, KECAK_SHEET_MAP } from '@haraka/shared';

type RunRow = Database['public']['Tables']['run']['Row'];
type RawImportInsert = Database['public']['Tables']['raw_import']['Insert'];
type RawImportRow = Database['public']['Tables']['raw_import']['Row'];

// ---------------------------------------------------------------------------
// 認証情報取得
// ---------------------------------------------------------------------------

interface OAuthCredentials {
  refreshToken: string;
  clientId: string;
  clientSecret: string;
}

/**
 * OAuth 認証情報を取得する。
 * ローカル: .env から読み込み
 * Cloud Run: Secret Manager から読み込み
 */
async function getCredentials(): Promise<OAuthCredentials> {
  // ローカル開発: .env に値がある場合はそれを使用
  if (process.env.GOOGLE_REFRESH_TOKEN && process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
    return {
      refreshToken: process.env.GOOGLE_REFRESH_TOKEN,
      clientId: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    };
  }

  // Cloud Run: Secret Manager から取得
  const { getSecret } = await import('../lib/secret-manager.js');
  const [refreshToken, clientId, clientSecret] = await Promise.all([
    getSecret('haraka-oauth-refresh-token'),
    getSecret('haraka-oauth-client-id'),
    getSecret('haraka-oauth-client-secret'),
  ]);
  return { refreshToken, clientId, clientSecret };
}

// ---------------------------------------------------------------------------
// バッチ挿入ヘルパー
// ---------------------------------------------------------------------------

const BATCH_SIZE = 500;

/**
 * 大量データをバッチに分割して insert する
 */
async function batchInsert<T extends Record<string, unknown>>(
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

// ---------------------------------------------------------------------------
// メイン処理
// ---------------------------------------------------------------------------

export async function runSync() {
  const supabase = createSupabaseClient();

  // ---- 1. Run レコード作成 ----
  const { data: run, error: runError } = await supabase
    .from('run')
    .insert({ triggered_by: process.env.TRIGGER || 'manual' })
    .select()
    .single<RunRow>();
  if (runError || !run) throw new Error(`Run作成失敗: ${runError?.message}`);
  console.log(`[sync] Run 作成: ${run.id}`);

  try {
    // ---- 2. OAuth access token 取得 ----
    const creds = await getCredentials();
    const accessToken = await refreshAccessToken(creds);
    console.log('[sync] Access token 取得完了');

    const kecakSpreadsheetId = process.env.KECAK_SPREADSHEET_ID;
    const harakaDbSpreadsheetId = process.env.HARAKA_DB_SPREADSHEET_ID;
    if (!kecakSpreadsheetId) throw new Error('KECAK_SPREADSHEET_ID が未設定です');
    if (!harakaDbSpreadsheetId) throw new Error('HARAKA_DB_SPREADSHEET_ID が未設定です');

    // ---- 3. KECAK 取得 + raw_import 保存 ----
    let totalImported = 0;
    const allRawImports: RawImportRow[] = [];

    for (const franchise of FRANCHISES) {
      const sheetName = KECAK_SHEET_MAP[franchise];
      console.log(`[sync] KECAK取得: ${sheetName} (${franchise})`);

      const rows = await fetchSheetValues({
        accessToken,
        spreadsheetId: kecakSpreadsheetId,
        range: `${sheetName}`,
      });

      const parsed = parseKecakRows(rows, franchise, run.id);
      if (parsed.length === 0) {
        console.log(`[sync]   → 0件（スキップ）`);
        continue;
      }

      // バッチ insert
      await batchInsert(supabase, 'raw_import', parsed as unknown as Record<string, unknown>[]);

      // insert したレコードを取得（prepared_card 変換用に id が必要）
      const { data: inserted, error: fetchError } = await supabase
        .from('raw_import')
        .select('*')
        .eq('run_id', run.id)
        .eq('franchise', franchise)
        .returns<RawImportRow[]>();
      if (fetchError) throw new Error(`raw_import 取得失敗: ${fetchError.message}`);

      allRawImports.push(...(inserted ?? []));
      totalImported += parsed.length;
      console.log(`[sync]   → ${parsed.length}件 インポート完了`);
    }

    // Run 統計更新: import フェーズ
    await supabase.from('run').update({
      total_imported: totalImported,
      import_done_at: new Date().toISOString(),
    }).eq('id', run.id);
    console.log(`[sync] インポート完了: 合計 ${totalImported}件`);

    // ---- 4. Haraka DB 照合用マップ構築 ----
    const lookupMaps = new Map<Franchise, ReturnType<typeof buildLookupMap>>();

    for (const franchise of FRANCHISES) {
      // Haraka DB のシート名はフランチャイズ名そのまま（英語）
      console.log(`[sync] Haraka DB 取得: ${franchise}`);

      const dbRows = await fetchSheetValues({
        accessToken,
        spreadsheetId: harakaDbSpreadsheetId,
        range: `${franchise}`,
      });

      const lookupMap = buildLookupMap(dbRows);
      lookupMaps.set(franchise, lookupMap);
      console.log(`[sync]   → LookupMap 構築完了`);
    }

    // ---- 5. PreparedCard 変換 + 保存 ----
    let totalPrepared = 0;

    for (const franchise of FRANCHISES) {
      const rawImports = allRawImports.filter(r => r.franchise === franchise);
      if (rawImports.length === 0) continue;

      const lookupMap = lookupMaps.get(franchise);
      if (!lookupMap) continue;

      const prepared = prepareCards(rawImports, lookupMap, franchise);
      if (prepared.length === 0) continue;

      await batchInsert(supabase, 'prepared_card', prepared as unknown as Record<string, unknown>[]);
      totalPrepared += prepared.length;
      console.log(`[sync] PreparedCard: ${franchise} → ${prepared.length}件`);
    }

    // ---- 6. Run 完了更新 ----
    await supabase.from('run').update({
      total_prepared: totalPrepared,
      prepare_done_at: new Date().toISOString(),
      status: 'completed',
      completed_at: new Date().toISOString(),
    }).eq('id', run.id);

    console.log(`[sync] 完了: imported=${totalImported}, prepared=${totalPrepared}`);

  } catch (err) {
    // エラー時: Run を failed に更新
    const message = err instanceof Error ? err.message : String(err);
    await supabase.from('run').update({
      status: 'failed',
      error_message: message,
    }).eq('id', run.id);
    throw err;
  }
}
