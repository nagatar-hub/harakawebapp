/**
 * ローカルまたは Supabase Storage 上のテンプレート PNG からレイアウト座標を自動検出する
 *
 * 処理：
 *   1. 入力ディレクトリの `買取表ひな形{N}枚{jp}.png` を読み込み
 *   2. detectLayoutFromBuffer で黒枠矩形を検出 → layout_config 算出
 *   3. 検出結果を可視化した PNG を `./out/debug-{slug}-{N}.png` に出力
 *   4. 全テンプレの検出結果を JSON で `./out/layout-templates.json` に出力
 *
 * 可視化 PNG を目視で確認してから Phase で seed 投入する。
 *
 * Usage:
 *   DOWNLOADS_DIR="C:\Users\nagat\Downloads\買取表複数フォーマットオリパーク" \
 *     OUT_DIR="./out" \
 *     npx tsx packages/job/src/scripts/detect-layout-slots.ts
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { detectLayoutFromBuffer, renderDetectionDebugImage } from '../lib/layout-detector.js';
import type { LayoutConfig } from '@haraka/shared';

const SLOT_COUNTS = [1, 2, 4, 6, 9, 15, 20] as const;

const SOURCES = [
  { jpTag: 'ポケカ', slug: 'pokemon', franchise: 'Pokemon' as const },
  { jpTag: '遊戯王', slug: 'yugioh', franchise: 'YU-GI-OH!' as const },
  { jpTag: 'ONEPIECE', slug: 'onepiece', franchise: 'ONE PIECE' as const },
];

interface DetectedResult {
  franchise: 'Pokemon' | 'ONE PIECE' | 'YU-GI-OH!';
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
  const dir = process.env.DOWNLOADS_DIR || 'C:\\Users\\nagat\\Downloads\\買取表複数フォーマットオリパーク';
  const outDir = process.env.OUT_DIR || './out';
  console.log(`[detect-layout] 入力: ${dir}`);
  console.log(`[detect-layout] 出力: ${outDir}`);
  await mkdir(outDir, { recursive: true });

  const results: DetectedResult[] = [];
  const failures: string[] = [];

  for (const { jpTag, slug, franchise } of SOURCES) {
    for (const slots of SLOT_COUNTS) {
      const fileName = `買取表ひな形${slots}枚${jpTag}.png`;
      const srcPath = join(dir, fileName);

      try {
        const buffer = await readFile(srcPath);
        const detected = await detectLayoutFromBuffer(buffer);

        // 期待値との食い違いを警告（修正は人間の判断）
        if (detected.totalSlots !== slots) {
          console.warn(
            `[detect-layout] ⚠ ${fileName}: 期待 ${slots} 枠 / 検出 ${detected.totalSlots} 枠`,
          );
        } else {
          console.log(
            `[detect-layout] ✓ ${fileName}: ${detected.gridCols}x${detected.gridRows}=${detected.totalSlots}`,
          );
        }

        // 可視化 PNG
        const debugBuffer = await renderDetectionDebugImage(buffer, detected);
        const debugPath = join(outDir, `debug-${slug}-${slots}.png`);
        await writeFile(debugPath, debugBuffer);

        results.push({
          franchise,
          franchiseSlug: slug,
          slots,
          source: fileName,
          templateStoragePath: `templates/${slug}/${slots}.png`,
          cardBackStoragePath: `card-backs/${slug}.png`,
          detected: {
            gridCols: detected.gridCols,
            gridRows: detected.gridRows,
            totalSlots: detected.totalSlots,
            imgWidth: detected.imgWidth,
            imgHeight: detected.imgHeight,
            boxCount: detected.boxes.length,
          },
          layoutConfig: detected.layoutConfig,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        failures.push(`${fileName}: ${msg}`);
        console.error(`[detect-layout] ✗ ${fileName}: ${msg}`);
      }
    }
  }

  // JSON 出力
  const jsonPath = join(outDir, 'layout-templates.json');
  await writeFile(jsonPath, JSON.stringify(results, null, 2), 'utf8');
  console.log(`\n[detect-layout] JSON 出力: ${jsonPath}`);
  console.log(`[detect-layout] 成功: ${results.length} 件 / 失敗: ${failures.length} 件`);

  if (failures.length > 0) {
    console.error('\n失敗詳細:');
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }

  console.log(
    `\n次ステップ：${outDir} 配下の debug-*.png を目視確認してください。` +
    `問題なければ seed-layout-templates スクリプトで Supabase に投入します。`,
  );
}

main().catch((err) => {
  console.error('[detect-layout] 失敗:', err);
  process.exit(1);
});
