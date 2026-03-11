/**
 * ページプランナー
 *
 * prepared_card 配列を rule に基づいてページに振り分ける。
 *
 * アルゴリズム:
 * 1. rules を priority 降順でソート
 * 2. 各 rule について:
 *    - behavior='isolate': マッチしたカードを専用ページに振り分け
 *    - behavior='exclude': マッチしたカードを除外（どのページにも含めない）
 *    - behavior='merge': マッチしたカードを1つのグループにまとめる（将来用）
 * 3. 残りのカードをタグ単位でグルーピングし、FFD ビンパッキングでページに振り分け
 *    - 各タググループ内は price_high 降順
 *    - ページ内のグループ配置は最高価格降順
 *    - グループを崩さずページに詰める（40枚超えそうなら次ページへ）
 */

import type { PreparedCardRow, RuleRow } from '@haraka/shared';

export type PagePlan = {
  /** ページラベル（"TOP", "リザードン", "general-1" 等） */
  label: string;
  /** このページに含まれる prepared_card.id 配列（最大 totalSlots 件） */
  cardIds: string[];
};

/**
 * ルールに基づいてカードの tag がマッチするか判定
 */
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

/**
 * カード配列を price_high 降順でソートし、totalSlots 件ずつページに分割
 * （isolate ページ向け: 同一テーマなのでタググルーピング不要）
 */
function splitIntoPages(
  cards: PreparedCardRow[],
  label: string,
  totalSlots: number,
): PagePlan[] {
  if (cards.length === 0) return [];

  // price_high 降順ソート
  const sorted = [...cards].sort((a, b) => (b.price_high ?? 0) - (a.price_high ?? 0));

  const pages: PagePlan[] = [];
  for (let i = 0; i < sorted.length; i += totalSlots) {
    const chunk = sorted.slice(i, i + totalSlots);
    const pageIndex = Math.floor(i / totalSlots);
    const pageLabel = pageIndex === 0 ? label : `${label}-${pageIndex + 1}`;
    pages.push({
      label: pageLabel,
      cardIds: chunk.map(c => c.id),
    });
  }

  return pages;
}

/**
 * カードをタグ単位でグルーピングし、FFD ビンパッキングでページに振り分ける。
 *
 * - 各タググループ内は price_high 降順
 * - グループを崩さず totalSlots 枚のページに詰める
 * - ページ内グループは最高価格降順で配置
 * - ページ自体も最高価格降順でソート
 */
function splitIntoGroupedPages(
  cards: PreparedCardRow[],
  totalSlots: number,
): PagePlan[] {
  if (cards.length === 0) return [];

  // 1. タグでグルーピング & 各グループを price_high 降順ソート
  const tagGroups = new Map<string, PreparedCardRow[]>();
  for (const card of cards) {
    const tag = card.tag || '__none__';
    if (!tagGroups.has(tag)) tagGroups.set(tag, []);
    tagGroups.get(tag)!.push(card);
  }
  for (const group of tagGroups.values()) {
    group.sort((a, b) => (b.price_high ?? 0) - (a.price_high ?? 0));
  }

  // 2. サイズ降順（同サイズなら最高価格降順）で FFD ビンパッキング
  const groups = [...tagGroups.entries()].sort((a, b) => {
    if (b[1].length !== a[1].length) return b[1].length - a[1].length;
    return (b[1][0]?.price_high ?? 0) - (a[1][0]?.price_high ?? 0);
  });

  const bins: PreparedCardRow[][] = [];
  const binSizes: number[] = [];

  for (const [, group] of groups) {
    // 1グループが1ページを超える → 分割
    if (group.length > totalSlots) {
      for (let i = 0; i < group.length; i += totalSlots) {
        bins.push(group.slice(i, i + totalSlots));
        binSizes.push(Math.min(group.length - i, totalSlots));
      }
      continue;
    }

    // 既存ビンに収まる場所を探す (First Fit)
    let placed = false;
    for (let b = 0; b < bins.length; b++) {
      if (binSizes[b] + group.length <= totalSlots) {
        bins[b].push(...group);
        binSizes[b] += group.length;
        placed = true;
        break;
      }
    }
    if (!placed) {
      bins.push([...group]);
      binSizes.push(group.length);
    }
  }

  // 3. 各ビン内でグループを最高価格順に再配置
  for (const bin of bins) {
    const sub = new Map<string, PreparedCardRow[]>();
    for (const card of bin) {
      const tag = card.tag || '__none__';
      if (!sub.has(tag)) sub.set(tag, []);
      sub.get(tag)!.push(card);
    }
    const sorted = [...sub.values()].sort(
      (a, b) => (b[0]?.price_high ?? 0) - (a[0]?.price_high ?? 0),
    );
    bin.length = 0;
    for (const g of sorted) bin.push(...g);
  }

  // 4. ページを最高価格順でソート
  bins.sort((a, b) => (b[0]?.price_high ?? 0) - (a[0]?.price_high ?? 0));

  // 5. PagePlan 変換（ラベルは呼び出し側で設定）
  return bins.map((binCards) => ({
    label: '',
    cardIds: binCards.map(c => c.id),
  }));
}

/**
 * prepared_card 配列を rules に基づいてページに振り分ける
 */
export function planPages(
  cards: PreparedCardRow[],
  rules: RuleRow[],
  totalSlots: number,
): PagePlan[] {
  if (cards.length === 0) return [];

  // rules を priority 降順でソート
  const sortedRules = [...rules].sort((a, b) => b.priority - a.priority);

  // まだどのルールにも振り分けられていないカードの Set
  const remaining = new Set(cards.map(c => c.id));
  const cardById = new Map(cards.map(c => [c.id, c]));

  const pages: PagePlan[] = [];

  for (const rule of sortedRules) {
    // マッチするカードを抽出
    const matchedCards: PreparedCardRow[] = [];
    for (const id of remaining) {
      const card = cardById.get(id)!;
      if (matchesRule(card.tag, rule)) {
        matchedCards.push(card);
      }
    }

    if (matchedCards.length === 0) continue;

    // remaining から除外
    for (const card of matchedCards) {
      remaining.delete(card.id);
    }

    switch (rule.behavior) {
      case 'isolate': {
        // 専用ページに振り分け（サブタグでグルーピング）
        const rulePages = splitIntoGroupedPages(matchedCards, totalSlots);
        rulePages.forEach((page, idx) => {
          page.label = idx === 0 ? rule.tag_pattern : `${rule.tag_pattern}-${idx + 1}`;
        });
        pages.push(...rulePages);
        break;
      }
      case 'exclude': {
        // 除外: どのページにも含めない（remaining から削除済み）
        break;
      }
      case 'merge': {
        // merge: 将来実装。現時点では isolate と同じ動作
        const rulePages = splitIntoGroupedPages(matchedCards, totalSlots);
        rulePages.forEach((page, idx) => {
          page.label = idx === 0 ? rule.tag_pattern : `${rule.tag_pattern}-${idx + 1}`;
        });
        pages.push(...rulePages);
        break;
      }
    }
  }

  // 残りのカードをタグ単位でグルーピングしてページに振り分け
  const remainingCards = Array.from(remaining).map(id => cardById.get(id)!);
  if (remainingCards.length > 0) {
    const generalPages = splitIntoGroupedPages(remainingCards, totalSlots);
    generalPages.forEach((page, index) => {
      page.label = `general-${index + 1}`;
    });
    pages.push(...generalPages);
  }

  return pages;
}
