/**
 * layout_template テーブルに全レイアウトを投入する冪等スクリプト
 *
 * 処理：
 *   1. out/layout-templates.json（detect-layout-slots 出力）を読み込み
 *      → 新規 21 レイアウト（ポケカ/遊戯王/ONE PIECE × 1/2/4/6/9/15/20）を upsert
 *   2. asset_profile の既存 40 枠レイアウトを変換して upsert（slug="grid_8x5"）
 *   3. asset_profile の BOX 40 枠レイアウト（layout_config.templateFileId_BOX 経由）を upsert
 *      （slug="box_8x5", skip_price_low=true）
 *
 * 前提：
 *   - migrate-assets-to-storage / upload-new-layout-templates が先に実行されていること
 *   - detect-layout-slots が実行されていること
 *
 * Usage:
 *   OUT_DIR="./out" npx tsx packages/job/src/scripts/seed-layout-templates.ts
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createSupabaseClientFromSecrets } from '../lib/supabase.js';
import { FRANCHISES } from '@haraka/shared';
import type {
  AssetProfileRow,
  LayoutTemplateRow,
  Franchise,
  LayoutConfig,
} from '@haraka/shared';

const FRANCHISE_SLUG: Record<Franchise, string> = {
  Pokemon: 'pokemon',
  'ONE PIECE': 'onepiece',
  'YU-GI-OH!': 'yugioh',
};

/**
 * 既存 40 枠レイアウトに対する行別 Y 微調整。
 * 旧版の generate.ts / regenerate-page.ts にハードコードされていた値を
 * layout_template 化するため、franchise 単位で移植する。
 */
const LEGACY_40_SLOT_ADJUSTMENTS: Record<Franchise, {
  layoutAdjust: { cardYDelta: number; priceYDelta: number };
  rowPriceAdjust: Record<number, { priceHighYDelta?: number; priceLowYDelta?: number }>;
  rowCardAdjust?: Record<number, number>;
}> = {
  'Pokemon': {
    layoutAdjust: { cardYDelta: -2, priceYDelta: 3 },
    rowPriceAdjust: {
      1: { priceHighYDelta: 4, priceLowYDelta: 5 },
      2: { priceLowYDelta: 2 },
      3: { priceHighYDelta: 3, priceLowYDelta: 1.5 },
      4: { priceHighYDelta: 4, priceLowYDelta: 3 },
    },
  },
  'ONE PIECE': {
    layoutAdjust: { cardYDelta: -2, priceYDelta: 3 },
    rowPriceAdjust: {
      1: { priceHighYDelta: 4, priceLowYDelta: 5 },
      2: { priceLowYDelta: 2 },
      3: { priceHighYDelta: 3, priceLowYDelta: 1.5 },
      4: { priceHighYDelta: 4, priceLowYDelta: 3 },
    },
  },
  'YU-GI-OH!': {
    layoutAdjust: { cardYDelta: 4, priceYDelta: 0 },
    rowPriceAdjust: {
      1: { priceHighYDelta: 4, priceLowYDelta: 5 },
      2: { priceLowYDelta: 2 },
      3: { priceHighYDelta: 3, priceLowYDelta: 1.5 },
      4: { priceHighYDelta: 4, priceLowYDelta: 3 },
    },
    rowCardAdjust: { 1: 8, 2: 3, 3: 3, 4: 3 },
  },
};

interface DetectedResult {
  franchise: Franchise;
  franchiseSlug: string;
  slots: number;
  source: string;
  templateStoragePath: string;
  cardBackStoragePath: string;
  detected: {
    gridCols: number;
    gridRows: number;
    totalSlots: number;
    imgWidth: number;
    imgHeight: number;
    boxCount: number;
  };
  layoutConfig: LayoutConfig;
}

async function main() {
  const outDir = process.env.OUT_DIR || './out';
  const jsonPath = join(outDir, 'layout-templates.json');

  console.log(`[seed-layout] 検出結果 JSON: ${jsonPath}`);
  const jsonBuf = await readFile(jsonPath, 'utf8');
  const detected: DetectedResult[] = JSON.parse(jsonBuf);

  const supabase = await createSupabaseClientFromSecrets();

  let inserted = 0;
  let updated = 0;

  async function upsertLayout(row: Omit<LayoutTemplateRow, 'id' | 'created_at' | 'updated_at'>): Promise<void> {
    // (store, franchise, slug) で既存を確認
    const { data: existing } = await supabase
      .from('layout_template')
      .select('id')
      .eq('store', row.store)
      .eq('franchise', row.franchise)
      .eq('slug', row.slug)
      .maybeSingle();

    if (existing) {
      const { error } = await supabase
        .from('layout_template')
        .update({
          name: row.name,
          grid_cols: row.grid_cols,
          grid_rows: row.grid_rows,
          total_slots: row.total_slots,
          img_width: row.img_width,
          img_height: row.img_height,
          template_storage_path: row.template_storage_path,
          card_back_storage_path: row.card_back_storage_path,
          layout_config: row.layout_config,
          skip_price_low: row.skip_price_low,
          is_default: row.is_default,
          is_active: row.is_active,
          priority: row.priority,
          updated_at: new Date().toISOString(),
        })
        .eq('id', existing.id);
      if (error) throw new Error(`update 失敗 ${row.franchise}/${row.slug}: ${error.message}`);
      updated++;
      console.log(`[seed-layout]   ↻ ${row.franchise} / ${row.slug} (${row.total_slots}枠)`);
    } else {
      const { error } = await supabase.from('layout_template').insert(row);
      if (error) throw new Error(`insert 失敗 ${row.franchise}/${row.slug}: ${error.message}`);
      inserted++;
      console.log(`[seed-layout]   + ${row.franchise} / ${row.slug} (${row.total_slots}枠)`);
    }
  }

  // ---- 1. 新規 21 レイアウト（検出結果から） ----
  console.log('\n[seed-layout] === 新規 21 レイアウト ===');
  for (const d of detected) {
    await upsertLayout({
      store: 'oripark',
      franchise: d.franchise,
      name: `${d.slots}枠 (${d.detected.gridCols}x${d.detected.gridRows})`,
      slug: `grid_${d.detected.gridCols}x${d.detected.gridRows}`,
      grid_cols: d.detected.gridCols,
      grid_rows: d.detected.gridRows,
      total_slots: d.detected.totalSlots,
      img_width: d.detected.imgWidth,
      img_height: d.detected.imgHeight,
      template_storage_path: d.templateStoragePath,
      card_back_storage_path: d.cardBackStoragePath,
      layout_config: d.layoutConfig,
      skip_price_low: false,
      is_default: false,
      is_active: true,
      priority: 0,
    });
  }

  // ---- 2. 既存 40 枠 / BOX 40 枠（asset_profile から） ----
  console.log('\n[seed-layout] === 既存 40 枠 / BOX 40 枠 ===');
  for (const franchise of FRANCHISES) {
    const slug = FRANCHISE_SLUG[franchise];

    const { data: profiles, error: profErr } = await supabase
      .from('asset_profile')
      .select('*')
      .eq('store', 'oripark')
      .eq('franchise', franchise)
      .returns<AssetProfileRow[]>();
    if (profErr || !profiles || profiles.length === 0) {
      console.warn(`[seed-layout]   スキップ: asset_profile 未登録 (store=oripark, franchise=${franchise})`);
      continue;
    }
    const profile = profiles[0];
    if (!profile.layout_config) {
      console.warn(`[seed-layout]   スキップ: layout_config 未設定 (${franchise})`);
      continue;
    }

    // Storage path が無い場合はスキップ（migrate-assets-to-storage を先に実行させる）
    if (!profile.template_storage_path || !profile.card_back_storage_path) {
      throw new Error(
        `asset_profile の *_storage_path が未設定 (${franchise})。migrate-assets-to-storage を先に実行してください。`,
      );
    }

    // 通常 40 枠（旧版のハードコード行調整を layout_config に取り込んで保存）
    const adj = LEGACY_40_SLOT_ADJUSTMENTS[franchise];
    const layoutConfigWithAdj: LayoutConfig = {
      ...profile.layout_config,
      layoutAdjust: adj.layoutAdjust,
      rowPriceAdjust: adj.rowPriceAdjust,
      rowCardAdjust: adj.rowCardAdjust,
    };

    await upsertLayout({
      store: 'oripark',
      franchise,
      name: '40枠 (8x5)',
      slug: 'grid_8x5',
      grid_cols: profile.grid_cols,
      grid_rows: profile.grid_rows,
      total_slots: profile.total_slots,
      img_width: profile.img_width,
      img_height: profile.img_height,
      template_storage_path: profile.template_storage_path,
      card_back_storage_path: profile.card_back_storage_path,
      layout_config: layoutConfigWithAdj,
      skip_price_low: false,
      is_default: true,
      is_active: true,
      priority: 0,
    });

    // BOX 40 枠（あれば）
    if (profile.template_box_storage_path) {
      const cardBackForBox = profile.card_back_box_storage_path ?? profile.card_back_storage_path;
      await upsertLayout({
        store: 'oripark',
        franchise,
        name: 'BOX 40枠 (8x5)',
        slug: 'box_8x5',
        grid_cols: profile.grid_cols,
        grid_rows: profile.grid_rows,
        total_slots: profile.total_slots,
        img_width: profile.img_width,
        img_height: profile.img_height,
        template_storage_path: profile.template_box_storage_path,
        card_back_storage_path: cardBackForBox,
        layout_config: layoutConfigWithAdj,
        skip_price_low: true,
        is_default: false,
        is_active: false, // BOX 用は page-planner の通常選択対象外（明示指定時のみ）
        priority: 0,
      });
    } else {
      console.warn(`[seed-layout]   BOX テンプレ未設定: ${franchise}（BOX 40 枠は登録しません）`);
    }

    console.log(`[seed-layout]   ${franchise}: 40 枠 ${profile.template_box_storage_path ? '+ BOX' : ''} 完了`);
  }

  console.log(`\n[seed-layout] 完了: ${inserted} 件 insert / ${updated} 件 update`);
  process.exit(0);
}

main().catch(err => {
  console.error('[seed-layout] 失敗:', err);
  process.exit(1);
});
