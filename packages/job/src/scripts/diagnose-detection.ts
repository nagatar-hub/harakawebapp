/**
 * 検出のクラスタリング過程を可視化する診断スクリプト
 *
 * 1 枚のテンプレートに対し、生の矩形候補・クラスタリング結果・除外された候補を
 * すべてコンソール出力する。
 *
 * Usage:
 *   npx tsx packages/job/src/scripts/diagnose-detection.ts \
 *     "C:\Users\nagat\Downloads\買取表複数フォーマットオリパーク\買取表ひな形6枚ポケカ.png"
 */

import { readFile } from 'node:fs/promises';
import sharp from 'sharp';

const BLACK_THRESHOLD = 80;
const MIN_BOX_WIDTH = 60;
const MIN_BOX_HEIGHT = 20;
const MAX_BOX_WIDTH = 600;
const MAX_BOX_HEIGHT = 300;
const MIN_FILL_RATIO = 0.01;
const MAX_FILL_RATIO = 0.40;
const MIN_ASPECT_RATIO = 1.2;

async function main() {
  const path = process.argv[2];
  if (!path) throw new Error('PNG パスを引数に指定してください');

  const buffer = await readFile(path);
  const { data, info } = await sharp(buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;
  const pxCount = width * height;

  const black = new Uint8Array(pxCount);
  for (let i = 0; i < pxCount; i++) {
    const r = data[i * channels], g = data[i * channels + 1], b = data[i * channels + 2], a = data[i * channels + 3];
    if (a < 128) continue;
    if (r < BLACK_THRESHOLD && g < BLACK_THRESHOLD && b < BLACK_THRESHOLD) black[i] = 1;
  }

  const labels = new Int32Array(pxCount);
  const queue = new Int32Array(pxCount);
  type Cand = { minX: number; minY: number; width: number; height: number; pixels: number; aspect: number; fill: number; passed: boolean };
  const allCands: Cand[] = [];
  let nextLabel = 0;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      if (!black[idx] || labels[idx] !== 0) continue;
      nextLabel++;
      let qh = 0, qt = 0;
      queue[qt++] = idx; labels[idx] = nextLabel;
      let minX = x, minY = y, maxX = x, maxY = y, pixels = 0;
      while (qh < qt) {
        const cur = queue[qh++];
        pixels++;
        const cy = (cur / width) | 0; const cx = cur - cy * width;
        if (cx < minX) minX = cx; if (cx > maxX) maxX = cx;
        if (cy < minY) minY = cy; if (cy > maxY) maxY = cy;
        if (cx > 0) { const n = cur - 1; if (black[n] && labels[n] === 0) { labels[n] = nextLabel; queue[qt++] = n; } }
        if (cx < width - 1) { const n = cur + 1; if (black[n] && labels[n] === 0) { labels[n] = nextLabel; queue[qt++] = n; } }
        if (cy > 0) { const n = cur - width; if (black[n] && labels[n] === 0) { labels[n] = nextLabel; queue[qt++] = n; } }
        if (cy < height - 1) { const n = cur + width; if (black[n] && labels[n] === 0) { labels[n] = nextLabel; queue[qt++] = n; } }
      }
      const w = maxX - minX + 1, h = maxY - minY + 1;
      const aspect = w / h, fill = pixels / (w * h);
      const passed = w >= MIN_BOX_WIDTH && w <= MAX_BOX_WIDTH &&
        h >= MIN_BOX_HEIGHT && h <= MAX_BOX_HEIGHT &&
        aspect >= MIN_ASPECT_RATIO &&
        fill >= MIN_FILL_RATIO && fill <= MAX_FILL_RATIO;
      allCands.push({ minX, minY, width: w, height: h, pixels, aspect, fill, passed });
    }
  }

  // 面積で降順ソート
  allCands.sort((a, b) => b.width * b.height - a.width * a.height);

  console.log(`Total connected components: ${allCands.length}`);
  console.log(`\n-- フィルタ通過した候補 (${allCands.filter(c => c.passed).length}件) --`);
  for (const c of allCands.filter(c => c.passed)) {
    console.log(`  x=${c.minX} y=${c.minY} w=${c.width} h=${c.height} aspect=${c.aspect.toFixed(2)} fill=${c.fill.toFixed(3)}`);
  }

  console.log(`\n-- 通過しなかった候補のうち大きめ (top 20, 面積降順) --`);
  const failed = allCands.filter(c => !c.passed).slice(0, 20);
  for (const c of failed) {
    const reasons: string[] = [];
    if (c.width < MIN_BOX_WIDTH || c.width > MAX_BOX_WIDTH) reasons.push(`w=${c.width}`);
    if (c.height < MIN_BOX_HEIGHT || c.height > MAX_BOX_HEIGHT) reasons.push(`h=${c.height}`);
    if (c.aspect < MIN_ASPECT_RATIO) reasons.push(`aspect=${c.aspect.toFixed(2)}`);
    if (c.fill < MIN_FILL_RATIO || c.fill > MAX_FILL_RATIO) reasons.push(`fill=${c.fill.toFixed(3)}`);
    console.log(`  x=${c.minX} y=${c.minY} w=${c.width} h=${c.height} [${reasons.join(', ')}]`);
  }
}

main().catch(err => { console.error(err); process.exit(1); });
