import type { Franchise } from '../types/franchise.js';

/**
 * 端数処理 - 全価格帯 500 円刻みで切り捨て、500 円未満は 0
 */
export function niceLowerBound(raw: number): number {
  if (raw < 500) return 0;
  return Math.floor(raw / 500) * 500;
}

/**
 * price_high を計算: KECAK / BUY_PRICE 等の元価格から 2% 引いて 500 円刻みに丸める
 */
export function calculateBuyPriceHigh(basePrice: number): number {
  if (!basePrice || basePrice <= 0) return 0;
  return niceLowerBound(basePrice * 0.98);
}

/**
 * 買取下限を計算
 *
 * 割引率（元価格に対する％）:
 * - 9,999円以下: 73%
 * - 10,000〜19,999円: 78%
 * - 20,000円以上: YU-GI-OH! は 83%, その他は 86%
 *
 * @param basePrice 元価格（KECAK 価格 / SPECTRE BUY_PRICE 等）
 */
export function calculateBuyPriceLow(basePrice: number, franchise: Franchise): number {
  if (!basePrice || basePrice <= 0) return 0;

  let rate: number;
  if (basePrice <= 9_999) {
    rate = 0.73;
  } else if (basePrice <= 19_999) {
    rate = 0.78;
  } else {
    rate = franchise === 'YU-GI-OH!' ? 0.83 : 0.86;
  }

  return niceLowerBound(basePrice * rate);
}
