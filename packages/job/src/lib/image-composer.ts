/**
 * 画像合成エンジン
 *
 * テンプレート画像の上に:
 * 1. カード画像を配置
 * 2. 価格テキスト（SVG）をオーバーレイ
 * 3. レアリティアイコンを重ね合わせ
 * 4. 日付スタンプを追加
 *
 * sharp ライブラリを使用して高速に合成する
 */

import sharp, { type OverlayOptions } from 'sharp';
import type { LayoutConfig, PreparedCardRow, AssetProfileRow } from '@haraka/shared';

// ---------------------------------------------------------------------------
// 型定義
// ---------------------------------------------------------------------------

export interface ComposePageParams {
  /** テンプレート画像の Buffer */
  templateBuffer: Buffer;
  /** カード裏面画像の Buffer */
  cardBackBuffer: Buffer;
  /** このページのカード配列（スロット順） */
  cards: PreparedCardRow[];
  /** レイアウト設定 */
  layout: LayoutConfig;
  /** アセットプロファイル */
  assetProfile: AssetProfileRow;
  /** レアリティアイコン: rarity_icon_url → Buffer */
  rarityIconBuffers?: Map<string, Buffer>;
  /** カード画像: card.id → Buffer */
  cardImageBuffers: Map<string, Buffer>;
  /** 日付文字列 (例: "2026/03/11") */
  dateText: string;
}

// ---------------------------------------------------------------------------
// SVG テキスト生成
// ---------------------------------------------------------------------------

/**
 * 価格テキスト用 SVG Buffer を生成
 */
function createPriceTextSvg(params: {
  text: string;
  width: number;
  height: number;
  fontFamily: string;
  color: string;
  fontSize: number;
}): Buffer {
  const { text, width, height, fontFamily, color, fontSize } = params;
  const svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
    <text
      x="${width / 2}"
      y="${height / 2 + fontSize * 0.35}"
      font-family="${fontFamily}, sans-serif"
      font-size="${fontSize}"
      fill="${color}"
      text-anchor="middle"
      dominant-baseline="auto"
    >${escapeXml(text)}</text>
  </svg>`;
  return Buffer.from(svg);
}

/**
 * 日付テキスト用 SVG Buffer を生成
 */
function createDateTextSvg(params: {
  text: string;
  fontFamily: string;
}): Buffer {
  const { text, fontFamily } = params;
  const width = 300;
  const height = 40;
  const fontSize = 24;
  const svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
    <text
      x="0"
      y="${fontSize}"
      font-family="${fontFamily}, sans-serif"
      font-size="${fontSize}"
      fill="#333333"
    >${escapeXml(text)}</text>
  </svg>`;
  return Buffer.from(svg);
}

/**
 * XML エスケープ
 */
function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// ---------------------------------------------------------------------------
// 価格フォーマット
// ---------------------------------------------------------------------------

/**
 * 数値を価格文字列に変換
 * format: "¥{price}" → "¥10,000"
 */
function formatPrice(price: number, format: string): string {
  const formatted = price.toLocaleString('ja-JP');
  return format.replace('{price}', formatted);
}

// ---------------------------------------------------------------------------
// メイン合成関数
// ---------------------------------------------------------------------------

/**
 * 1 ページ分の買取表画像を生成
 */
export async function composePage(params: ComposePageParams): Promise<Buffer> {
  const {
    templateBuffer,
    cardBackBuffer,
    cards,
    layout,
    assetProfile,
    rarityIconBuffers,
    cardImageBuffers,
    dateText,
  } = params;

  const cols = assetProfile.grid_cols;
  const composites: OverlayOptions[] = [];

  // カード裏面をリサイズしておく
  const cardBackResized = await sharp(cardBackBuffer)
    .resize(layout.cardWidth, layout.cardHeight, { fit: 'fill' })
    .png()
    .toBuffer();

  // 各カードスロットを処理
  for (let i = 0; i < cards.length; i++) {
    const card = cards[i];
    const col = i % cols;
    const rowIndex = Math.floor(i / cols);

    // 行が layout.rows を超えたらスキップ
    if (rowIndex >= layout.rows.length) break;

    const rowConfig = layout.rows[rowIndex];
    const x = layout.startX + col * layout.colWidth;

    // ---- カード画像 ----
    let cardBuffer: Buffer;
    const imageBuffer = cardImageBuffers.get(card.id);

    if (imageBuffer) {
      // カード画像が取得できた
      try {
        cardBuffer = await sharp(imageBuffer)
          .resize(layout.cardWidth, layout.cardHeight, { fit: 'cover' })
          .png()
          .toBuffer();
      } catch {
        // リサイズ失敗時はカード裏面を使用
        cardBuffer = cardBackResized;
      }
    } else {
      // 画像なし → カード裏面
      cardBuffer = cardBackResized;
    }

    composites.push({
      input: cardBuffer,
      left: x,
      top: rowConfig.cardY,
    });

    // ---- レアリティアイコン ----
    if (
      card.rarity_icon_url &&
      rarityIconBuffers?.has(card.rarity_icon_url) &&
      layout.rarityIconWidth &&
      layout.rarityIconHeight
    ) {
      try {
        const iconBuffer = await sharp(rarityIconBuffers.get(card.rarity_icon_url)!)
          .resize(layout.rarityIconWidth, layout.rarityIconHeight, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
          .png()
          .toBuffer();

        composites.push({
          input: iconBuffer,
          left: x + (layout.rarityIconOffsetX ?? 0),
          top: rowConfig.cardY + (layout.rarityIconOffsetY ?? 0),
        });
      } catch {
        // アイコンリサイズ失敗は無視
      }
    }

    // ---- 価格テキスト ----
    const priceX = layout.priceStartX + col * layout.colWidth;
    const fontSize = layout.isSmallCard ? 14 : 16;

    if (card.price_high && card.price_high > 0) {
      // price_high（赤）
      const priceHighText = formatPrice(card.price_high, assetProfile.price_format);
      const priceHighSvg = createPriceTextSvg({
        text: priceHighText,
        width: layout.priceBoxWidth,
        height: layout.priceBoxHeight,
        fontFamily: assetProfile.font_family,
        color: '#CC0000',
        fontSize,
      });
      composites.push({
        input: priceHighSvg,
        left: priceX,
        top: rowConfig.priceHighY,
      });

      // price_low（青）
      if (card.price_low && card.price_low > 0) {
        const priceLowText = formatPrice(card.price_low, assetProfile.price_format);
        const priceLowSvg = createPriceTextSvg({
          text: priceLowText,
          width: layout.priceBoxWidth,
          height: layout.priceBoxHeight,
          fontFamily: assetProfile.font_family,
          color: '#0033CC',
          fontSize,
        });
        composites.push({
          input: priceLowSvg,
          left: priceX,
          top: rowConfig.priceLowY,
        });
      }
    }
  }

  // ---- 日付スタンプ ----
  const dateSvg = createDateTextSvg({
    text: dateText,
    fontFamily: assetProfile.font_family,
  });
  composites.push({
    input: dateSvg,
    left: layout.dateX,
    top: layout.dateY,
  });

  // ---- 合成実行 ----
  const result = await sharp(templateBuffer)
    .composite(composites)
    .png()
    .toBuffer();

  return result;
}
