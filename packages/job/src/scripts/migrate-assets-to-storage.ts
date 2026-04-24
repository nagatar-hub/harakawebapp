/**
 * 既存 Drive アセットを Supabase Storage へ移行する 1 回限りのスクリプト
 *
 * 対象：
 *   - asset_profile.template_image        → templates/{franchise}/40.png
 *   - asset_profile.card_back_image        → card-backs/{franchise}.png
 *   - asset_profile.layout_config.templateFileId_BOX → templates/{franchise}/box_40.png
 *   - asset_profile.layout_config.cardBackId_BOX     → card-backs/{franchise}_box.png
 *   - Google Sheets "RarityIcons" タブに登録された全アイコン → rarity-icons/{name}.png
 *
 * 完了後：
 *   - asset_profile に template_storage_path / card_back_storage_path /
 *     template_box_storage_path / card_back_box_storage_path を書き戻す
 *   - rarity_icon テーブルに全アイコンを upsert
 *
 * Drive 側のファイルは削除しない（バックアップとして保持）。
 *
 * Usage:
 *   npx tsx packages/job/src/scripts/migrate-assets-to-storage.ts
 */

import { createSupabaseClientFromSecrets } from '../lib/supabase.js';
import { getAccessToken, getHarakaDbSpreadsheetId } from '../lib/auth.js';
import { downloadDriveFile } from '../lib/google-drive.js';
import { fetchSheetValues } from '../lib/google-sheets.js';
import { uploadToStorage } from '../lib/asset-storage.js';
import { FRANCHISES } from '@haraka/shared';
import type { AssetProfileRow, Franchise } from '@haraka/shared';

const FRANCHISE_SLUG: Record<Franchise, string> = {
  Pokemon: 'pokemon',
  'ONE PIECE': 'onepiece',
  'YU-GI-OH!': 'yugioh',
};

function sanitizeFileName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._\-ぁ-んァ-ヶ一-龯]/g, '_');
}

async function migrateDriveToStorage(params: {
  supabase: Awaited<ReturnType<typeof createSupabaseClientFromSecrets>>;
  accessToken: string;
  driveId: string;
  storagePath: string;
  label: string;
}): Promise<void> {
  const { supabase, accessToken, driveId, storagePath, label } = params;
  console.log(`[migrate]   ${label}: Drive(${driveId}) → Storage(${storagePath}) ...`);
  const buffer = await downloadDriveFile(accessToken, driveId);
  await uploadToStorage(supabase, storagePath, buffer);
  console.log(`[migrate]     ↑ ${buffer.length} bytes`);
}

async function main() {
  console.log('[migrate] Supabase Storage 移行スクリプト開始');
  const supabase = await createSupabaseClientFromSecrets();
  const accessToken = await getAccessToken();
  console.log('[migrate] Access token 取得完了');

  // ---- 1. asset_profile の franchise ごとに移行 ----
  for (const franchise of FRANCHISES) {
    const slug = FRANCHISE_SLUG[franchise];
    console.log(`\n[migrate] === ${franchise} (${slug}) ===`);

    const { data: profiles, error } = await supabase
      .from('asset_profile')
      .select('*')
      .eq('franchise', franchise)
      .returns<AssetProfileRow[]>();
    if (error || !profiles || profiles.length === 0) {
      console.warn(`[migrate]   スキップ: profile 未登録`);
      continue;
    }
    const profile = profiles[0];

    const updates: Partial<AssetProfileRow> = {};
    const layoutConfig = profile.layout_config as
      | (NonNullable<AssetProfileRow['layout_config']> & {
          templateFileId_BOX?: string;
          cardBackId_BOX?: string;
        })
      | null;

    // 通常テンプレート
    if (profile.template_image) {
      const storagePath = `templates/${slug}/40.png`;
      await migrateDriveToStorage({
        supabase,
        accessToken,
        driveId: profile.template_image,
        storagePath,
        label: `${franchise} 通常テンプレ`,
      });
      updates.template_storage_path = storagePath;
    }

    // カード裏面
    if (profile.card_back_image) {
      const storagePath = `card-backs/${slug}.png`;
      await migrateDriveToStorage({
        supabase,
        accessToken,
        driveId: profile.card_back_image,
        storagePath,
        label: `${franchise} カード裏面`,
      });
      updates.card_back_storage_path = storagePath;
    }

    // BOX テンプレート
    if (layoutConfig?.templateFileId_BOX) {
      const storagePath = `templates/${slug}/box_40.png`;
      await migrateDriveToStorage({
        supabase,
        accessToken,
        driveId: layoutConfig.templateFileId_BOX,
        storagePath,
        label: `${franchise} BOX テンプレ`,
      });
      updates.template_box_storage_path = storagePath;
    }

    // BOX カード裏面
    if (layoutConfig?.cardBackId_BOX) {
      const storagePath = `card-backs/${slug}_box.png`;
      await migrateDriveToStorage({
        supabase,
        accessToken,
        driveId: layoutConfig.cardBackId_BOX,
        storagePath,
        label: `${franchise} BOX カード裏面`,
      });
      updates.card_back_box_storage_path = storagePath;
    }

    if (Object.keys(updates).length > 0) {
      const { error: updateError } = await supabase
        .from('asset_profile')
        .update(updates)
        .eq('id', profile.id);
      if (updateError) {
        throw new Error(`asset_profile 更新失敗 (${franchise}): ${updateError.message}`);
      }
      console.log(`[migrate]   asset_profile 更新: ${Object.keys(updates).join(', ')}`);
    }
  }

  // ---- 2. レアリティアイコン ----
  console.log(`\n[migrate] === RarityIcons ===`);
  const spreadsheetId = await getHarakaDbSpreadsheetId();
  let iconRows: string[][];
  try {
    iconRows = await fetchSheetValues({
      accessToken,
      spreadsheetId,
      range: 'RarityIcons!A2:B500',
    });
  } catch (err) {
    console.warn(`[migrate]   RarityIcons シート読込失敗: ${err instanceof Error ? err.message : err}`);
    iconRows = [];
  }

  let iconMigrated = 0;
  let iconSkipped = 0;
  for (const row of iconRows) {
    const name = row[0]?.trim();
    const driveId = row[1]?.trim();
    if (!name || !driveId) continue;

    const safeName = sanitizeFileName(name);
    const storagePath = `rarity-icons/${safeName}.png`;

    try {
      const buffer = await downloadDriveFile(accessToken, driveId);
      await uploadToStorage(supabase, storagePath, buffer);

      // upsert（共通アイコンのみ扱い。franchise 固有が必要なら将来シートを分離）
      const { error: upsertErr } = await supabase
        .from('rarity_icon')
        .upsert(
          {
            franchise: null,
            name,
            storage_path: storagePath,
            drive_id: driveId,
          },
          { onConflict: 'franchise,name' },
        );
      if (upsertErr) {
        // COALESCE インデックスの onConflict は通常指定できない。失敗したら手動で check → insert/update。
        const { data: existing } = await supabase
          .from('rarity_icon')
          .select('id')
          .is('franchise', null)
          .eq('name', name)
          .maybeSingle();
        if (existing) {
          await supabase.from('rarity_icon').update({ storage_path: storagePath, drive_id: driveId }).eq('id', existing.id);
        } else {
          await supabase.from('rarity_icon').insert({ franchise: null, name, storage_path: storagePath, drive_id: driveId });
        }
      }
      iconMigrated++;
      if (iconMigrated % 10 === 0) console.log(`[migrate]   アイコン: ${iconMigrated} 件処理`);
    } catch (err) {
      iconSkipped++;
      console.warn(`[migrate]   アイコン移行失敗: ${name} (${driveId}) — ${err instanceof Error ? err.message : err}`);
    }
  }

  console.log(`[migrate]   アイコン完了: ${iconMigrated} 件移行 / ${iconSkipped} 件スキップ`);
  console.log('\n[migrate] 全体完了');
  process.exit(0);
}

main().catch((err) => {
  console.error('[migrate] 失敗:', err);
  process.exit(1);
});
