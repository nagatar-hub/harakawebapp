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
 * 3. 残りのカードを price_high 降順で 40 件ずつ一般ページに振り分け
 * 4. 各ページ内のカードは price_high 降順ソート
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
        // 専用ページに振り分け
        const rulePages = splitIntoPages(matchedCards, rule.tag_pattern, totalSlots);
        pages.push(...rulePages);
        break;
      }
      case 'exclude': {
        // 除外: どのページにも含めない（remaining から削除済み）
        break;
      }
      case 'merge': {
        // merge: 将来実装。現時点では isolate と同じ動作
        const rulePages = splitIntoPages(matchedCards, rule.tag_pattern, totalSlots);
        pages.push(...rulePages);
        break;
      }
    }
  }

  // 残りのカードを一般ページに振り分け
  const remainingCards = Array.from(remaining).map(id => cardById.get(id)!);
  if (remainingCards.length > 0) {
    const generalPages = splitIntoPages(remainingCards, 'general-1', totalSlots);
    // general ページの label を "general-1", "general-2", ... に統一
    generalPages.forEach((page, index) => {
      page.label = `general-${index + 1}`;
    });
    pages.push(...generalPages);
  }

  return pages;
}
