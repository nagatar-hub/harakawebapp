/**
 * ページプランナー
 *
 * prepared_card 配列を rule に基づいてグループに振り分け、各グループを
 * レイアウト候補（`layout_template`）の最適組合せでページ化する。
 *
 * 処理の流れ:
 *   1. rules を priority 降順に処理
 *      - isolate     : マッチしたカードを専用グループに分離
 *      - exclude     : マッチしたカードを除外（ページ化しない）
 *      - merge       : isolate と同様（予約）
 *      - group       : 複数タグをまたいで 1 つのグループに集約
 *   2. 残りのカードはメインタグ（"/"の前）ごとにグループ化
 *   3. 各グループについて `selectLayoutCombination` で組合せを選び、
 *      price_high 降順で **小さい枠から順に** カードを割り当てる
 *      （= 最高額のカードが少枠ページで大きく表示される）
 *
 * 重要な変更点（旧版との差分）:
 *   - 旧: FFD ビンパッキングで複数タグを 1 ページ（40 枠）に詰めていた
 *   - 新: タグ跨ぎの合体は rule.behavior='group' に一本化し、タグ単位で独立にページ化
 */

import type {
  PreparedCardRow,
  RuleRow,
  LayoutTemplateRow,
} from '@haraka/shared';
import { selectLayoutCombination } from './layout-selector.js';

// ---------------------------------------------------------------------------
// ユーティリティ
// ---------------------------------------------------------------------------

/** 数値を丸数字に変換（1→①, 2→②, ...20→⑳） */
const CIRCLED_NUMBERS = '①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳';
function toCircledNumber(n: number): string {
  if (n >= 1 && n <= 20) return CIRCLED_NUMBERS[n - 1];
  return `-${n}`;
}

/** タグからメインカテゴリを抽出（"TAG/SA" → "TAG", "V/CSR" → "V"） */
function mainTag(tag: string | null): string {
  if (!tag) return '__none__';
  const slash = tag.indexOf('/');
  return slash >= 0 ? tag.slice(0, slash) : tag;
}

/** ルールにマッチするか判定 */
function matchesRule(tag: string | null, rule: RuleRow): boolean {
  if (!tag) return false;
  switch (rule.match_type) {
    case 'exact':
      return tag === rule.tag_pattern;
    case 'contains':
      return tag.includes(rule.tag_pattern);
    case 'regex':
      try {
        return new RegExp(rule.tag_pattern).test(tag);
      } catch {
        return false;
      }
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// 型定義
// ---------------------------------------------------------------------------

export type PagePlan = {
  /** ページラベル（"TOP", "リザードン", "25th_XY_BWR-2" 等） */
  label: string;
  /** このページに含まれる prepared_card.id 配列 */
  cardIds: string[];
  /** このページで使用するレイアウトテンプレート ID */
  layoutTemplateId: string;
};

// ---------------------------------------------------------------------------
// グループ → 複数ページへの割付
// ---------------------------------------------------------------------------

/**
 * 指定カード群を price_high 降順でソート後、最適な layout 組合せに振り分ける。
 *
 * - 小さいレイアウトから順に上位カードを詰める（= 高価格を spotlight）
 * - 組合せが決まらない（候補 0 等）場合は空配列
 * - 1 組合せでページ数 1 → label そのまま、複数ページ → `${label}`, `${label}-2`, ...
 */
function assignGroupToLayouts(
  cards: PreparedCardRow[],
  layouts: LayoutTemplateRow[],
  baseLabel: string,
): PagePlan[] {
  if (cards.length === 0) return [];

  const sorted = [...cards].sort((a, b) => (b.price_high ?? 0) - (a.price_high ?? 0));
  const combo = selectLayoutCombination(sorted.length, layouts);
  if (!combo || combo.layouts.length === 0) return [];

  const plans: PagePlan[] = [];
  let cursor = 0;
  combo.layouts.forEach((layout, idx) => {
    const slots = layout.total_slots;
    const chunk = sorted.slice(cursor, cursor + slots);
    cursor += slots;
    const pageLabel = idx === 0 ? baseLabel : `${baseLabel}-${idx + 1}`;
    plans.push({
      label: pageLabel,
      cardIds: chunk.map(c => c.id),
      layoutTemplateId: layout.id,
    });
  });

  return plans;
}

/**
 * BOX タグ（rule.tag_pattern === 'BOX'）用に固定 box_8x5 レイアウトに割り当てる。
 * 動作は旧版の挙動踏襲：40 枠単位で分割、価格降順、label は "BOX" / "BOX-2" ...
 */
function assignBoxGroup(
  cards: PreparedCardRow[],
  layouts: LayoutTemplateRow[],
  baseLabel: string,
): PagePlan[] {
  if (cards.length === 0) return [];

  const boxLayout = layouts.find(l => l.slug === 'box_8x5');
  if (!boxLayout) {
    // BOX レイアウト未登録なら通常 DP へフォールバック
    return assignGroupToLayouts(cards, layouts, baseLabel);
  }

  const sorted = [...cards].sort((a, b) => (b.price_high ?? 0) - (a.price_high ?? 0));
  const slots = boxLayout.total_slots;
  const plans: PagePlan[] = [];
  for (let i = 0; i < sorted.length; i += slots) {
    const chunk = sorted.slice(i, i + slots);
    const idx = Math.floor(i / slots);
    const pageLabel = idx === 0 ? baseLabel : `${baseLabel}-${idx + 1}`;
    plans.push({
      label: pageLabel,
      cardIds: chunk.map(c => c.id),
      layoutTemplateId: boxLayout.id,
    });
  }
  return plans;
}

// ---------------------------------------------------------------------------
// メイン関数
// ---------------------------------------------------------------------------

/**
 * prepared_card 配列を rules・layout_template 候補に基づいてページ化する。
 *
 * @param cards    有効な prepared_card（タグ・価格付き前提）
 * @param rules    この franchise のルール配列
 * @param layouts  この (store, franchise) で有効な layout_template 配列
 */
export function planPages(
  cards: PreparedCardRow[],
  rules: RuleRow[],
  layouts: LayoutTemplateRow[],
): PagePlan[] {
  if (cards.length === 0) return [];
  if (layouts.length === 0) return [];

  // rules を priority 降順
  const sortedRules = [...rules].sort((a, b) => b.priority - a.priority);

  // 残カード Set
  const remaining = new Set(cards.map(c => c.id));
  const cardById = new Map(cards.map(c => [c.id, c]));

  const pages: PagePlan[] = [];

  // group rule を group_key ごとに先に集約
  const groupMap = new Map<string, RuleRow[]>();
  const nonGroupRules: RuleRow[] = [];
  for (const rule of sortedRules) {
    if (rule.behavior === 'group' && rule.group_key) {
      const arr = groupMap.get(rule.group_key) ?? [];
      arr.push(rule);
      groupMap.set(rule.group_key, arr);
    } else {
      nonGroupRules.push(rule);
    }
  }

  // -- isolate / exclude / merge --
  for (const rule of nonGroupRules) {
    const matched: PreparedCardRow[] = [];
    for (const id of remaining) {
      const card = cardById.get(id)!;
      if (matchesRule(card.tag, rule)) matched.push(card);
    }
    if (matched.length === 0) continue;
    for (const c of matched) remaining.delete(c.id);

    switch (rule.behavior) {
      case 'isolate':
      case 'merge': {
        // BOX タグは専用レイアウト（box_8x5）を使用
        if (rule.tag_pattern === 'BOX' && rule.match_type === 'exact') {
          pages.push(...assignBoxGroup(matched, layouts, rule.tag_pattern));
        } else {
          pages.push(...assignGroupToLayouts(matched, layouts, rule.tag_pattern));
        }
        break;
      }
      case 'exclude':
        break;
    }
  }

  // -- group rules --
  for (const [groupKey, groupRules] of groupMap) {
    const matched: PreparedCardRow[] = [];
    for (const id of remaining) {
      const card = cardById.get(id)!;
      if (groupRules.some(r => matchesRule(card.tag, r))) matched.push(card);
    }
    if (matched.length === 0) continue;
    for (const c of matched) remaining.delete(c.id);

    pages.push(...assignGroupToLayouts(matched, layouts, groupKey));
  }

  // -- 残り: メインタグごとに独立割当 --
  const mainTagBuckets = new Map<string, PreparedCardRow[]>();
  for (const id of remaining) {
    const card = cardById.get(id)!;
    const key = mainTag(card.tag);
    const bucket = mainTagBuckets.get(key) ?? [];
    bucket.push(card);
    mainTagBuckets.set(key, bucket);
  }

  // メインタグ間の並び順は、各バケットの最高価格降順
  const sortedBuckets = [...mainTagBuckets.entries()].sort((a, b) => {
    const aMax = Math.max(...a[1].map(c => c.price_high ?? 0));
    const bMax = Math.max(...b[1].map(c => c.price_high ?? 0));
    return bMax - aMax;
  });

  // ラベル重複を解決するカウンタ（タグなしは全て「その他」に寄せて丸数字）
  const labelCounts = new Map<string, number>();

  for (const [tagKey, bucket] of sortedBuckets) {
    const baseLabel = tagKey === '__none__'
      ? 'その他'
      : tagKey;

    const seen = (labelCounts.get(baseLabel) ?? 0) + 1;
    labelCounts.set(baseLabel, seen);

    // 同じ baseLabel が 2 回目以降なら丸数字を付けて区別
    const effectiveLabel = seen === 1 ? baseLabel : `${baseLabel}${toCircledNumber(seen)}`;
    pages.push(...assignGroupToLayouts(bucket, layouts, effectiveLabel));
  }

  return pages;
}
