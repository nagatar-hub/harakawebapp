/**
 * 単一ページ再生成ジョブ
 *
 * 指定された generated_page ID の画像を再生成する。
 * カードデータは prepared_card から最新の値を取得するため、
 * 価格や画像URLの変更後に再生成すれば反映される。
 */

import sharp from 'sharp';
import { createSupabaseClientFromSecrets } from '../lib/supabase.js';
import { getAccessToken } from '../lib/auth.js';
import { composePage } from '../lib/image-composer.js';
import { downloadImagesWithConcurrency } from '../lib/google-drive.js';
import { downloadTemplateAsset } from '../lib/asset-storage.js';
import type {
  PreparedCardRow,
  AssetProfileRow,
  GeneratedPageRow,
  LayoutTemplateRow,
  RarityIconRow,
} from '@haraka/shared';

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

export async function runRegeneratePage() {
  const pageId = process.env.PAGE_ID;
  if (!pageId) throw new Error('PAGE_ID が未設定です');

  const supabase = await createSupabaseClientFromSecrets();
  console.log(`[regenerate-page] ページ再生成開始: ${pageId}`);

  try {
    await _runRegeneratePage(supabase, pageId);
  } catch (err) {
    // 失敗時: ステータスを generated に戻して元画像を維持（ギャラリーから消えないようにする）
    // error_message にエラー内容を記録し、ポーリング側で検知可能にする
    const errMsg = err instanceof Error ? err.message : String(err);
    await supabase.from('generated_page').update({
      status: 'generated',
      error_message: `再生成失敗: ${errMsg}`,
    }).eq('id', pageId);
    throw err;
  }
}

async function _runRegeneratePage(supabase: Awaited<ReturnType<typeof createSupabaseClientFromSecrets>>, pageId: string) {

  // ---- 1. ページ情報取得 ----
  const { data: page, error: pageErr } = await supabase
    .from('generated_page')
    .select('*')
    .eq('id', pageId)
    .single<GeneratedPageRow>();

  if (pageErr || !page) throw new Error(`ページが見つかりません: ${pageErr?.message}`);

  // ---- 2. カードデータ取得 ----
  const { data: cards, error: cardErr } = await supabase
    .from('prepared_card')
    .select('*')
    .in('id', page.card_ids)
    .returns<PreparedCardRow[]>();

  if (cardErr) throw new Error(`カード取得失敗: ${cardErr.message}`);

  // card_ids の順序を保持
  const cardMap = new Map((cards || []).map(c => [c.id, c]));
  const orderedCards = page.card_ids.map(id => cardMap.get(id)!).filter(Boolean);

  console.log(`[regenerate-page] カード数: ${orderedCards.length}`);

  // ---- 3. アセットプロファイル + layout_template 取得 ----
  const { data: profiles, error: profileErr } = await supabase
    .from('asset_profile')
    .select('*')
    .eq('store', 'oripark')
    .eq('franchise', page.franchise as 'Pokemon' | 'ONE PIECE' | 'YU-GI-OH!')
    .limit(1)
    .returns<AssetProfileRow[]>();

  const profile = profiles?.[0] ?? null;
  if (profileErr || !profile) throw new Error(`プロファイルが見つかりません (store=oripark, franchise=${page.franchise}): ${profileErr?.message ?? '該当なし'}`);

  if (!page.layout_template_id) {
    throw new Error(`generated_page.layout_template_id が未設定です (page_id=${page.id})`);
  }
  const { data: layoutRow, error: layoutErr } = await supabase
    .from('layout_template')
    .select('*')
    .eq('id', page.layout_template_id)
    .single<LayoutTemplateRow>();
  if (layoutErr || !layoutRow) throw new Error(`layout_template 取得失敗: ${layoutErr?.message ?? '該当なし'}`);
  const layout = layoutRow.layout_config;

  // ---- 4. アセットダウンロード（Storage 優先、Drive フォールバック） ----
  const accessToken = await getAccessToken();

  const templateBuffer = await downloadTemplateAsset({
    supabase, storagePath: layoutRow.template_storage_path, driveId: null,
    accessToken, label: `${page.franchise}/${layoutRow.slug} テンプレ`,
  });
  const cardBackBuffer = await downloadTemplateAsset({
    supabase, storagePath: layoutRow.card_back_storage_path, driveId: null,
    accessToken, label: `${page.franchise}/${layoutRow.slug} カード裏`,
  });

  console.log(`[regenerate-page] テンプレート・カード裏面ダウンロード完了（${layoutRow.slug}）`);

  // レアリティアイコン（rarity_icon テーブル優先）
  const rarityIconBuffers = new Map<string, Buffer>();
  const neededRarities = new Set<string>();
  for (const card of orderedCards) {
    if (card.rarity_icon_url) neededRarities.add(card.rarity_icon_url);
  }
  if (neededRarities.size > 0) {
    const { data: rarityRows } = await supabase
      .from('rarity_icon')
      .select('*')
      .or(`franchise.eq.${page.franchise},franchise.is.null`)
      .returns<RarityIconRow[]>();
    const rarityByName = new Map<string, RarityIconRow>();
    for (const r of rarityRows ?? []) rarityByName.set(r.name, r);

    for (const name of neededRarities) {
      const icon = rarityByName.get(name);
      try {
        const buf = await downloadTemplateAsset({
          supabase,
          storagePath: icon?.storage_path ?? null,
          driveId: icon?.drive_id ?? null,
          accessToken,
          label: `rarity/${name}`,
        });
        rarityIconBuffers.set(name, buf);
      } catch (err) {
        console.log(`[regenerate-page] アイコン取得失敗: ${name} — ${err instanceof Error ? err.message : err}`);
      }
    }
  }

  // ---- 5. カード画像ダウンロード（image_url → alt_image_url フォールバック） ----
  const primaryUrls = orderedCards.map(c => c.image_url || c.alt_image_url || null);
  const primaryBuffers = await downloadImagesWithConcurrency(accessToken, primaryUrls, 8);

  // primary が失敗 or sharp で読めない場合、alt_image_url で再試行
  const altRetryIndices: number[] = [];
  for (let ci = 0; ci < orderedCards.length; ci++) {
    const buf = primaryBuffers[ci];
    if (!buf && orderedCards[ci].alt_image_url && orderedCards[ci].image_url) {
      altRetryIndices.push(ci);
    } else if (buf) {
      try {
        await sharp(buf).metadata();
      } catch {
        primaryBuffers[ci] = null;
        if (orderedCards[ci].alt_image_url) {
          altRetryIndices.push(ci);
        }
      }
    }
  }

  if (altRetryIndices.length > 0) {
    const altUrls = altRetryIndices.map(ci => orderedCards[ci].alt_image_url!);
    const altBuffers = await downloadImagesWithConcurrency(accessToken, altUrls, 8);
    altRetryIndices.forEach((ci, ai) => {
      if (altBuffers[ai]) {
        primaryBuffers[ci] = altBuffers[ai];
        console.log(`[regenerate-page] alt_image_url で復旧: ${orderedCards[ci].card_name}`);
      }
    });
  }

  const cardImageBuffers = new Map<string, Buffer>();
  orderedCards.forEach((card, i) => {
    const buf = primaryBuffers[i];
    if (buf) cardImageBuffers.set(card.id, buf);
  });

  console.log(`[regenerate-page] カード画像: ${cardImageBuffers.size}/${orderedCards.length}枚ダウンロード`);

  // ---- 6. 画像合成 ----
  const today = new Date();
  const dateText = `${String(today.getMonth() + 1).padStart(2, '0')}/${String(today.getDate()).padStart(2, '0')}`;

  console.log(`[regenerate-page] 画像合成開始...`);
  const imageBuffer = await composePage({
    templateBuffer,
    cardBackBuffer,
    cards: orderedCards,
    layout,
    assetProfile: profile,
    rarityIconBuffers,
    cardImageBuffers,
    dateText,
    skipPriceLow: layoutRow.skip_price_low,
    layoutAdjust: layout.layoutAdjust,
    rowPriceAdjust: layout.rowPriceAdjust,
    rowCardAdjust: layout.rowCardAdjust,
    totalSlots: layoutRow.total_slots,
  });

  // ---- 7. Storage アップロード ----
  const datePath = `${today.getFullYear()}/${String(today.getMonth() + 1).padStart(2, '0')}/${String(today.getDate()).padStart(2, '0')}`;
  const safeFranchise = page.franchise.replace(/[^a-zA-Z0-9._-]/g, '') || 'franchise';
  const label = page.page_label ?? '';
  const safeLabel = romanizeLabel(label);
  const storageKey = page.image_key || `generated/${datePath}/${safeFranchise}/page_${page.page_index}_${safeLabel}.png`;

  const { error: uploadError } = await supabase.storage
    .from('haraka-images')
    .upload(storageKey, imageBuffer, {
      contentType: 'image/png',
      upsert: true,
    });

  if (uploadError) throw new Error(`Storage アップロード失敗: ${uploadError.message}`);

  const { data: publicUrl } = supabase.storage
    .from('haraka-images')
    .getPublicUrl(storageKey);

  // ---- 9. generated_page 更新 ----
  await supabase.from('generated_page').update({
    status: 'generated',
    image_key: storageKey,
    image_url: publicUrl.publicUrl,
    error_message: null,
  }).eq('id', pageId);

  console.log(`[regenerate-page] 完了: ${storageKey}`);
}
