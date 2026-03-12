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
// ヘルパー関数
// ---------------------------------------------------------------------------

/**
 * 同一 list_no + grade のカードを重複排除する。
 * 優先順位: KECAK > SPECTRE > manual（同一ソースなら price_high が高い方）
 * list_no がない場合は card.id をキーとして重複排除しない。
 */
function deduplicateByListNo(cards: PreparedCardRow[]): PreparedCardRow[] {
  const SOURCE_PRIORITY: Record<string, number> = { kecak: 2, spectre: 1, manual: 0 };
  const map = new Map<string, PreparedCardRow>();
  for (const card of cards) {
    const key = card.list_no
      ? `${card.list_no}|${card.grade ?? ''}`
      : card.id;
    const existing = map.get(key);
    if (!existing) {
      map.set(key, card);
      continue;
    }
    const existPri = SOURCE_PRIORITY[existing.source] ?? 0;
    const cardPri = SOURCE_PRIORITY[card.source] ?? 0;
    if (cardPri > existPri || (cardPri === existPri && (card.price_high ?? 0) > (existing.price_high ?? 0))) {
      map.set(key, card);
    }
  }
  return Array.from(map.values());
}

const LABEL_MAP: Record<string, string> = {
  'ピカチュウ': 'pikachu',
  'イーブイ': 'eevee',
  'リザードン': 'charizard',
  'サポート': 'support',
  'ゲンガー': 'gengar',
  '青眼': 'blue-eyes',
  'ブラックマジシャン': 'dark-magician',
};

function romanizeLabel(label: string): string {
  for (const [jp, en] of Object.entries(LABEL_MAP)) {
    label = label.replace(jp, en);
  }
  return label.replace(/[^a-zA-Z0-9._-]/g, '') || 'page';
}

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

  // 日付ベースのストレージパス (YYYY/MM/DD)
  const today = new Date();
  const datePath = `${today.getFullYear()}/${String(today.getMonth() + 1).padStart(2, '0')}/${String(today.getDate()).padStart(2, '0')}`;

  try {
    // ---- 1.5. 同日分の生成データをクリーンアップ ----
    console.log('[generate] 同日分データクリーンアップ中...');
    // generated_page + spectre prepared_card を削除
    await supabase.from('generated_page').delete().eq('run_id', run.id);
    await supabase.from('prepared_card').delete().eq('run_id', run.id).eq('source', 'spectre');

    // Storage の同日画像を削除（generated/YYYY/MM/DD/{franchise}/ 配下）
    for (const folder of ['Pokemon', 'ONEPIECE', 'YU-GI-OH']) {
      const prefix = `generated/${datePath}/${folder}`;
      const { data: files } = await supabase.storage.from('haraka-images').list(prefix);
      if (files && files.length > 0) {
        const paths = files.map(f => `${prefix}/${f.name}`);
        await supabase.storage.from('haraka-images').remove(paths);
        console.log(`[generate]   ${folder}: ${paths.length}件削除`);
      }
    }

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
    const dateText = `${String(today.getMonth() + 1).padStart(2, '0')}/${String(today.getDate()).padStart(2, '0')}`;
    let rarityIconMap: Map<string, string> | null = null; // レアリティ名→Drive ID
    const rarityIconCache = new Map<string, Buffer>(); // レアリティ名→Buffer（フランチャイズ跨ぎキャッシュ）

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

      // 重複排除: 同一 list_no + grade は KECAK 優先 → price_high 高い方
      const deduplicatedCards = deduplicateByListNo(cards);
      console.log(`[generate]   重複排除後: ${deduplicatedCards.length}件（${cards.length - deduplicatedCards.length}件除外）`);

      // タグなしカードを除外してアラート
      const untaggedCards = deduplicatedCards.filter(c => !c.tag);
      const taggedCards = deduplicatedCards.filter(c => c.tag);
      if (untaggedCards.length > 0) {
        console.warn(`[generate]   ⚠️ タグ未設定カード ${untaggedCards.length}件（ページ生成から除外）:`);
        for (const c of untaggedCards) {
          console.warn(`[generate]     - ${c.card_name} (${c.grade ?? ''} ${c.list_no ?? ''}) price=¥${(c.price_high ?? 0).toLocaleString()}`);
        }
      }

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

      // 4d. ページプランニング（タグなしカードは除外済み）
      const layout = profile.layout_config as LayoutConfig;
      const pagePlans = planPages(taggedCards, rules ?? [], profile.total_slots);
      console.log(`[generate]   ページ数: ${pagePlans.length}`);

      // タグ構成ログ（グルーピング確認用）
      const cardById = new Map(taggedCards.map(c => [c.id, c]));
      for (const plan of pagePlans) {
        const tagCounts = new Map<string, number>();
        for (const id of plan.cardIds) {
          const tag = cardById.get(id)?.tag || '?';
          tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1);
        }
        const tagSummary = [...tagCounts.entries()]
          .map(([t, n]) => `${t}(${n})`)
          .join(', ');
        console.log(`[generate]     ${plan.label} [${plan.cardIds.length}枚]: ${tagSummary}`);
      }

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

      // 4f. レアリティアイコンダウンロード（RarityIcons シートから）
      const rarityIconBuffers = new Map<string, Buffer>();
      if (!rarityIconMap) {
        // 初回のみシートを読む（全フランチャイズ共通）
        try {
          const iconRows = await fetchSheetValues({
            accessToken,
            spreadsheetId: harakaDbSpreadsheetId,
            range: 'RarityIcons!A2:B100',
          });
          rarityIconMap = new Map<string, string>();
          for (const row of iconRows) {
            const name = row[0]?.trim();
            const driveId = row[1]?.trim();
            if (name && driveId) rarityIconMap.set(name, driveId);
          }
          console.log(`[generate] RarityIcons シート読込: ${rarityIconMap.size}件`);
        } catch (e) {
          console.log(`[generate] RarityIcons シート読込失敗:`, e);
          rarityIconMap = new Map();
        }
      }
      // このフランチャイズのカードが使うレアリティのみダウンロード
      const neededRarities = new Set(cards.map(c => c.rarity_icon_url).filter(Boolean) as string[]);
      for (const rarityName of neededRarities) {
        if (rarityIconBuffers.has(rarityName)) continue;
        // グローバルキャッシュにあればそこから
        if (rarityIconCache.has(rarityName)) {
          rarityIconBuffers.set(rarityName, rarityIconCache.get(rarityName)!);
          continue;
        }
        const driveId = rarityIconMap.get(rarityName);
        if (!driveId) {
          console.log(`[generate]     レアリティアイコン未登録: ${rarityName}`);
          continue;
        }
        try {
          const buf = await downloadDriveFile(accessToken, driveId);
          rarityIconBuffers.set(rarityName, buf);
          rarityIconCache.set(rarityName, buf);
        } catch {
          console.log(`[generate]     アイコンダウンロード失敗: ${rarityName} (${driveId})`);
        }
      }
      if (neededRarities.size > 0) {
        console.log(`[generate]   レアリティアイコン: ${rarityIconBuffers.size}/${neededRarities.size}種ダウンロード`);
      }

      // 4g. 各ページの画像を生成
      // cardById は上でタグ構成ログ用に定義済み

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

        // レイアウト微調整
        const layoutAdjust = franchise === 'YU-GI-OH!'
          ? { cardYDelta: 4, priceYDelta: 0 }
          : { cardYDelta: -2, priceYDelta: 3 }; // Pokemon / ONE PIECE

        // 行別の価格Y微調整（全フランチャイズ共通）
        const rowPriceAdjust: Record<number, { priceHighYDelta?: number; priceLowYDelta?: number }> = {
          1: { priceHighYDelta: 4, priceLowYDelta: 5 },     // 2段目
          2: { priceLowYDelta: 2 },                          // 3段目(中央)
          3: { priceHighYDelta: 3, priceLowYDelta: 1.5 },   // 4段目
          4: { priceHighYDelta: 4, priceLowYDelta: 3 },     // 5段目(最下段)
        };

        // 行別のカードY微調整（遊戯王のみ）
        const rowCardAdjust = franchise === 'YU-GI-OH!'
          ? { 1: 8, 2: 3, 3: 3, 4: 3 } as Record<number, number>
          : undefined;

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
            skipPriceLow: isBOX,
            layoutAdjust,
            rowPriceAdjust,
            rowCardAdjust,
            totalSlots: profile.total_slots,
          });

          // Supabase Storage にアップロード
          // キーは ASCII のみ許容 — ラベルはローマ字マップで変換してインデックスで一意性を担保
          const safeLabel = romanizeLabel(plan.label);
          const safeFranchise = franchise.replace(/[^a-zA-Z0-9._-]/g, '') || 'franchise';
          const storageKey = `generated/${datePath}/${safeFranchise}/page_${pageIdx}_${safeLabel}.png`;

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
