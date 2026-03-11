/**
 * Generate ジョブ — Phase 2 画像生成パイプライン
 *
 * 処理フロー:
 * 1. 最新の completed run を取得
 * 2. OAuth access token 取得
 * 3. Spectre 取込: SpectreMapping → prepared_card (source='spectre')
 * 4. 各 franchise:
 *    a. prepared_card 取得
 *    b. asset_profile + rule 取得
 *    c. ページプランニング → generated_page 保存
 *    d. 画像合成 → Supabase Storage 保存
 * 5. Run 完了更新
 */

import { createSupabaseClient } from '../lib/supabase.js';
import { fetchSheetValues } from '../lib/google-sheets.js';
import { getAccessToken } from '../lib/auth.js';
import { batchInsert } from '../lib/batch.js';
import { parseSpectreRows } from '../lib/spectre-parser.js';
import { planPages } from '../lib/page-planner.js';
import { composePage } from '../lib/image-composer.js';
import { downloadDriveFile, downloadImagesWithConcurrency } from '../lib/google-drive.js';
import type {
  Database,
  PreparedCardRow,
  AssetProfileRow,
  RuleRow,
  LayoutConfig,
  GeneratedPageRow,
} from '@haraka/shared';
import { FRANCHISES } from '@haraka/shared';

type RunRow = Database['public']['Tables']['run']['Row'];
type GeneratedPageInsert = Database['public']['Tables']['generated_page']['Insert'];

// ---------------------------------------------------------------------------
// メイン処理
// ---------------------------------------------------------------------------

export async function runGenerate() {
  const supabase = createSupabaseClient();

  // ---- 1. 最新の completed run を取得 ----
  const { data: run, error: runFindError } = await supabase
    .from('run')
    .select('*')
    .eq('status', 'completed')
    .order('started_at', { ascending: false })
    .limit(1)
    .single<RunRow>();
  if (runFindError || !run) throw new Error(`completed Run が見つかりません: ${runFindError?.message}`);
  console.log(`[generate] Run 使用: ${run.id}`);

  // Run を再度 running に更新（generate フェーズ開始）
  await supabase.from('run').update({ status: 'running' }).eq('id', run.id);

  try {
    // ---- 2. OAuth access token 取得 ----
    const accessToken = await getAccessToken();
    console.log('[generate] Access token 取得完了');

    const harakaDbSpreadsheetId = process.env.HARAKA_DB_SPREADSHEET_ID;
    if (!harakaDbSpreadsheetId) throw new Error('HARAKA_DB_SPREADSHEET_ID が未設定です');

    // ---- 3. Spectre 取込 ----
    console.log('[generate] SpectreMapping 取得中...');
    try {
      const spectreRows = await fetchSheetValues({
        accessToken,
        spreadsheetId: harakaDbSpreadsheetId,
        range: 'SpectreMapping',
      });

      if (spectreRows.length > 1) {
        // SpectreMapping は Pokemon 向け（現時点では）
        const spectreCards = parseSpectreRows(spectreRows, 'Pokemon', run.id);
        if (spectreCards.length > 0) {
          await batchInsert(supabase, 'prepared_card', spectreCards as unknown as Record<string, unknown>[]);
          console.log(`[generate] Spectre カード: ${spectreCards.length}件 追加`);
        }
      }
    } catch (spectreErr) {
      // SpectreMapping が存在しない場合はスキップ
      console.log(`[generate] SpectreMapping スキップ: ${spectreErr instanceof Error ? spectreErr.message : String(spectreErr)}`);
    }

    // ---- 4. franchise ごとにページ生成 ----
    let totalPages = 0;
    const today = new Date();
    const dateText = `${today.getFullYear()}/${String(today.getMonth() + 1).padStart(2, '0')}/${String(today.getDate()).padStart(2, '0')}`;

    for (const franchise of FRANCHISES) {
      console.log(`[generate] === ${franchise} ===`);

      // 4a. prepared_card 取得
      const { data: cards, error: cardsError } = await supabase
        .from('prepared_card')
        .select('*')
        .eq('run_id', run.id)
        .eq('franchise', franchise)
        .returns<PreparedCardRow[]>();
      if (cardsError) throw new Error(`prepared_card 取得失敗: ${cardsError.message}`);
      if (!cards || cards.length === 0) {
        console.log(`[generate]   → カード 0件（スキップ）`);
        continue;
      }
      console.log(`[generate]   カード: ${cards.length}件`);

      // 4b. asset_profile 取得
      const { data: profile, error: profileError } = await supabase
        .from('asset_profile')
        .select('*')
        .eq('franchise', franchise)
        .single<AssetProfileRow>();
      if (profileError || !profile) throw new Error(`asset_profile 取得失敗 (${franchise}): ${profileError?.message}`);
      if (!profile.layout_config) throw new Error(`layout_config が未設定 (${franchise})`);

      // 4c. rule 取得
      const { data: rules, error: rulesError } = await supabase
        .from('rule')
        .select('*')
        .eq('franchise', franchise)
        .returns<RuleRow[]>();
      if (rulesError) throw new Error(`rule 取得失敗: ${rulesError.message}`);

      // 4d. ページプランニング
      const layout = profile.layout_config as LayoutConfig;
      const pagePlans = planPages(cards, rules ?? [], profile.total_slots);
      console.log(`[generate]   ページ数: ${pagePlans.length}`);

      if (pagePlans.length === 0) continue;

      // generated_page レコードを insert
      const pageInserts: GeneratedPageInsert[] = pagePlans.map((plan, index) => ({
        run_id: run.id,
        franchise,
        page_index: index,
        page_label: plan.label,
        card_ids: plan.cardIds,
        status: 'pending' as const,
      }));
      await batchInsert(supabase, 'generated_page', pageInserts as unknown as Record<string, unknown>[]);

      // plan_done_at を更新
      await supabase.from('run').update({
        plan_done_at: new Date().toISOString(),
        total_pages: totalPages + pagePlans.length,
      }).eq('id', run.id);

      // 4e. テンプレート + カード裏面をダウンロード
      const templateFileId = profile.template_image;
      const cardBackFileId = profile.card_back_image;
      if (!templateFileId || !cardBackFileId) {
        console.log(`[generate]   テンプレート/カード裏面未設定（スキップ）`);
        continue;
      }

      console.log(`[generate]   テンプレート/カード裏面ダウンロード中...`);
      const [templateBuffer, cardBackBuffer] = await Promise.all([
        downloadDriveFile(accessToken, templateFileId),
        downloadDriveFile(accessToken, cardBackFileId),
      ]);

      // BOX テンプレート（layout_config 内の追加フィールド）
      const extendedLayout = profile.layout_config as LayoutConfig & {
        templateFileId_BOX?: string;
        cardBackId_BOX?: string;
      };
      let templateBufferBOX: Buffer | null = null;
      let cardBackBufferBOX: Buffer | null = null;
      if (extendedLayout.templateFileId_BOX) {
        try {
          [templateBufferBOX, cardBackBufferBOX] = await Promise.all([
            downloadDriveFile(accessToken, extendedLayout.templateFileId_BOX),
            extendedLayout.cardBackId_BOX
              ? downloadDriveFile(accessToken, extendedLayout.cardBackId_BOX)
              : Promise.resolve(cardBackBuffer),
          ]);
        } catch {
          console.log(`[generate]   BOXテンプレートダウンロード失敗（通常テンプレートを使用）`);
        }
      }

      // 4f. レアリティアイコンダウンロード
      const rarityIconBuffers = new Map<string, Buffer>();
      if (profile.rarity_icons) {
        console.log(`[generate]   レアリティアイコンダウンロード中...`);
        for (const [, driveId] of Object.entries(profile.rarity_icons)) {
          if (driveId && !rarityIconBuffers.has(driveId)) {
            try {
              const buf = await downloadDriveFile(accessToken, driveId);
              rarityIconBuffers.set(driveId, buf);
            } catch {
              console.log(`[generate]     アイコンダウンロード失敗: ${driveId}`);
            }
          }
        }
      }

      // 4g. 各ページの画像を生成
      const cardById = new Map(cards.map(c => [c.id, c]));

      // generated_page レコードを取得（ID が必要）
      const { data: generatedPages } = await supabase
        .from('generated_page')
        .select('*')
        .eq('run_id', run.id)
        .eq('franchise', franchise)
        .order('page_index', { ascending: true })
        .returns<GeneratedPageRow[]>();

      for (let pageIdx = 0; pageIdx < pagePlans.length; pageIdx++) {
        const plan = pagePlans[pageIdx];
        const pageCards = plan.cardIds.map(id => cardById.get(id)!).filter(Boolean);
        const generatedPage = generatedPages?.[pageIdx];

        console.log(`[generate]   ページ ${pageIdx + 1}/${pagePlans.length} (${plan.label}): ${pageCards.length}枚`);

        // BOX ページか判定
        const isBOX = plan.label === 'BOX' || plan.label.startsWith('BOX-');
        const currentTemplate = (isBOX && templateBufferBOX) ? templateBufferBOX : templateBuffer;
        const currentCardBack = (isBOX && cardBackBufferBOX) ? cardBackBufferBOX : cardBackBuffer;

        // カード画像のダウンロード
        const imageUrls = pageCards.map(c => c.image_url || c.alt_image_url || null);
        const imageBuffers = await downloadImagesWithConcurrency(accessToken, imageUrls, 8);

        const cardImageBuffers = new Map<string, Buffer>();
        pageCards.forEach((card, i) => {
          const buf = imageBuffers[i];
          if (buf) cardImageBuffers.set(card.id, buf);
        });

        // 画像合成
        try {
          const imageBuffer = await composePage({
            templateBuffer: currentTemplate,
            cardBackBuffer: currentCardBack,
            cards: pageCards,
            layout,
            assetProfile: profile,
            rarityIconBuffers,
            cardImageBuffers,
            dateText,
          });

          // Supabase Storage にアップロード
          // キーは ASCII のみ許容 — 非ASCII文字を除去してインデックスで一意性を担保
          const safeLabel = plan.label.replace(/[^a-zA-Z0-9._-]/g, '');
          const safeFranchise = franchise.replace(/[^a-zA-Z0-9._-]/g, '');
          const storageKey = `generated/${run.id}/${safeFranchise || 'franchise'}/page_${pageIdx}_${safeLabel || 'rule'}.png`;

          const { error: uploadError } = await supabase.storage
            .from('haraka-images')
            .upload(storageKey, imageBuffer, {
              contentType: 'image/png',
              upsert: true,
            });

          if (uploadError) {
            console.log(`[generate]     Storage アップロード失敗: ${uploadError.message}`);
            if (generatedPage) {
              await supabase.from('generated_page').update({
                status: 'failed',
              }).eq('id', generatedPage.id);
            }
            continue;
          }

          // 公開 URL 取得
          const { data: publicUrl } = supabase.storage
            .from('haraka-images')
            .getPublicUrl(storageKey);

          // generated_page 更新
          if (generatedPage) {
            await supabase.from('generated_page').update({
              status: 'generated',
              image_key: storageKey,
              image_url: publicUrl.publicUrl,
            }).eq('id', generatedPage.id);
          }

          console.log(`[generate]     → 生成完了: ${storageKey}`);
        } catch (composeErr) {
          console.error(`[generate]     → 合成失敗:`, composeErr);
          if (generatedPage) {
            await supabase.from('generated_page').update({
              status: 'failed',
            }).eq('id', generatedPage.id);
          }
        }
      }

      totalPages += pagePlans.length;
    }

    // ---- 5. Run 完了更新 ----
    await supabase.from('run').update({
      total_pages: totalPages,
      generate_done_at: new Date().toISOString(),
      status: 'completed',
      completed_at: new Date().toISOString(),
    }).eq('id', run.id);

    console.log(`[generate] 完了: total_pages=${totalPages}`);

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await supabase.from('run').update({
      status: 'failed',
      error_message: message,
    }).eq('id', run.id);
    throw err;
  }
}
