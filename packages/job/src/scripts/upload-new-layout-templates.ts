/**
 * ローカルの新規レイアウトテンプレート PNG（21 枚）を Supabase Storage にアップロードする
 *
 * 入力：`C:\Users\nagat\Downloads\買取表複数フォーマットオリパーク\` 配下の
 *   買取表ひな形{N}枚{ポケカ|遊戯王|ONEPIECE}.png
 *
 * 出力先：haraka-images バケット下
 *   templates/pokemon/{N}.png
 *   templates/yugioh/{N}.png
 *   templates/onepiece/{N}.png
 *
 * Usage:
 *   DOWNLOADS_DIR="C:\Users\nagat\Downloads\買取表複数フォーマットオリパーク" \
 *     npx tsx packages/job/src/scripts/upload-new-layout-templates.ts
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createSupabaseClientFromSecrets } from '../lib/supabase.js';
import { uploadToStorage } from '../lib/asset-storage.js';

const SLOT_COUNTS = [1, 2, 4, 6, 9, 15, 20] as const;

// ファイル名に含まれる商材ラベル → Storage サブディレクトリ
const SOURCES = [
  { jpTag: 'ポケカ', slug: 'pokemon' },
  { jpTag: '遊戯王', slug: 'yugioh' },
  { jpTag: 'ONEPIECE', slug: 'onepiece' },
] as const;

async function main() {
  const dir = process.env.DOWNLOADS_DIR || 'C:\\Users\\nagat\\Downloads\\買取表複数フォーマットオリパーク';
  console.log(`[upload-layouts] 入力ディレクトリ: ${dir}`);

  const supabase = await createSupabaseClientFromSecrets();

  let uploaded = 0;
  let failed = 0;
  const errors: string[] = [];

  for (const { jpTag, slug } of SOURCES) {
    for (const slots of SLOT_COUNTS) {
      const fileName = `買取表ひな形${slots}枚${jpTag}.png`;
      const srcPath = join(dir, fileName);
      const dstPath = `templates/${slug}/${slots}.png`;

      try {
        const buffer = await readFile(srcPath);
        await uploadToStorage(supabase, dstPath, buffer);
        console.log(`[upload-layouts] ${fileName} → ${dstPath} (${buffer.length} bytes)`);
        uploaded++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`${fileName}: ${msg}`);
        failed++;
      }
    }
  }

  console.log(`\n[upload-layouts] 完了: ${uploaded} 件アップ / ${failed} 件失敗`);
  if (errors.length > 0) {
    console.error('[upload-layouts] 失敗詳細:');
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error('[upload-layouts] 失敗:', err);
  process.exit(1);
});
