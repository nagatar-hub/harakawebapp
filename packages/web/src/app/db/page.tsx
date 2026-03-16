'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { FranchiseTabs } from '@/components/franchise-tabs';

type DbCard = {
  id: string;
  franchise: string;
  tag: string | null;
  card_name: string;
  grade: string | null;
  list_no: string | null;
  image_url: string | null;
  alt_image_url: string | null;
  rarity_icon: string | null;
  sheet_row_number: number | null;
  image_status: 'ok' | 'dead' | null;
};

type Stats = {
  total: number;
  byFranchise: Record<string, number>;
  errorCount: number;
  deadCount: number;
};

const FRANCHISE_JA: Record<string, string> = {
  'Pokemon': 'ポケモン',
  'ONE PIECE': 'ワンピース',
  'YU-GI-OH!': '遊戯王',
};

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8080';

/** タグ選択プルダウン */
function TagSelectCell({
  value,
  options,
  onSave,
}: {
  value: string;
  options: string[];
  onSave: (newValue: string) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const selectRef = useRef<HTMLSelectElement>(null);

  useEffect(() => {
    if (editing) {
      setTimeout(() => selectRef.current?.focus(), 0);
    }
  }, [editing]);

  const handleChange = async (newVal: string) => {
    if (newVal === value) {
      setEditing(false);
      return;
    }
    setSaving(true);
    try {
      await onSave(newVal);
    } finally {
      setSaving(false);
      setEditing(false);
    }
  };

  if (editing) {
    return (
      <select
        ref={selectRef}
        value={value}
        onChange={(e) => handleChange(e.target.value)}
        onBlur={() => setEditing(false)}
        disabled={saving}
        className="w-full px-2 py-1 text-sm border border-[#b8a080] rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-[#b8a080] disabled:opacity-50"
      >
        <option value="">（タグなし）</option>
        {options.map((t) => (
          <option key={t} value={t}>{t}</option>
        ))}
      </select>
    );
  }

  return (
    <button
      type="button"
      onClick={() => setEditing(true)}
      className="w-full text-left cursor-pointer hover:bg-[#e8ddd0] rounded-lg px-1 py-0.5 transition-colors"
      title="クリックで変更"
    >
      {value ? (
        <span className="inline-block px-3 py-1 bg-text-primary/10 text-text-primary rounded-full text-xs font-medium">
          {value}
        </span>
      ) : (
        <span className="inline-block px-3 py-1 bg-red-50 text-red-500 border border-red-200 rounded-full text-xs font-medium">
          タグなし
        </span>
      )}
    </button>
  );
}

/** インライン編集セル（テキスト入力） */
function InlineEditCell({
  value,
  placeholder,
  onSave,
  renderDisplay,
}: {
  value: string;
  placeholder?: string;
  onSave: (newValue: string) => Promise<void>;
  renderDisplay?: (value: string) => React.ReactNode;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) {
      setDraft(value);
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [editing, value]);

  const handleSave = async () => {
    if (draft === value) {
      setEditing(false);
      return;
    }
    setSaving(true);
    try {
      await onSave(draft);
    } finally {
      setSaving(false);
      setEditing(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleSave();
    } else if (e.key === 'Escape') {
      setEditing(false);
    }
  };

  if (editing) {
    return (
      <input
        ref={inputRef}
        type="text"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={handleSave}
        onKeyDown={handleKeyDown}
        disabled={saving}
        placeholder={placeholder}
        className="w-full px-2 py-1 text-sm border border-[#b8a080] rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-[#b8a080] disabled:opacity-50"
      />
    );
  }

  return (
    <button
      type="button"
      onClick={() => setEditing(true)}
      className="w-full text-left cursor-pointer hover:bg-[#e8ddd0] rounded-lg px-1 py-0.5 transition-colors group"
      title="クリックで編集"
    >
      {renderDisplay ? renderDisplay(value) : (
        <span className={value ? 'text-text-primary text-sm' : 'text-text-secondary text-xs italic'}>
          {value || (placeholder ?? '未設定')}
        </span>
      )}
    </button>
  );
}

export default function DbPage() {
  const [cards, setCards] = useState<DbCard[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [tagOptions, setTagOptions] = useState<Record<string, string[]>>({});
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('all');
  const [healthChecking, setHealthChecking] = useState(false);
  const [healthResult, setHealthResult] = useState<{ checked: number; ok: number; dead: number } | null>(null);
  const [previewCard, setPreviewCard] = useState<DbCard | null>(null);
  const [sortBy, setSortBy] = useState<'default' | 'tag' | 'tag-desc'>('default');

  const isErrorTab = filter === 'error';

  const fetchCards = useCallback(async (franchise: string) => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (franchise === 'error') {
        params.set('tab', 'error');
      } else if (franchise !== 'all') {
        params.set('franchise', franchise);
      }
      const res = await fetch(`${API_URL}/api/db-cards?${params}`);
      if (res.ok) setCards(await res.json());
    } catch { /* */ }
    setLoading(false);
  }, []);

  const fetchStats = useCallback(async () => {
    try {
      const res = await fetch(`${API_URL}/api/db-cards/stats`);
      if (res.ok) setStats(await res.json());
    } catch { /* */ }
  }, []);

  const fetchTagOptions = useCallback(async () => {
    try {
      const res = await fetch(`${API_URL}/api/db-cards/tags`);
      if (res.ok) setTagOptions(await res.json());
    } catch { /* */ }
  }, []);

  useEffect(() => {
    fetchCards(filter);
  }, [filter, fetchCards]);

  useEffect(() => {
    fetchStats();
    fetchTagOptions();
  }, [fetchStats, fetchTagOptions]);

  /** カード更新 PATCH */
  const updateCard = useCallback(async (id: string, field: 'tag' | 'alt_image_url', value: string) => {
    const res = await fetch(`${API_URL}/api/db-cards/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ [field]: value }),
    });
    if (!res.ok) throw new Error('更新に失敗しました');
    const updated: DbCard = await res.json();
    setCards((prev) => prev.map((c) => (c.id === id ? updated : c)));
    fetchStats();
    // タグが新規追加された場合、オプションも再取得
    if (field === 'tag') fetchTagOptions();
  }, [fetchStats, fetchTagOptions]);

  /** 画像ヘルスチェック実行 */
  const runHealthCheck = useCallback(async () => {
    setHealthChecking(true);
    setHealthResult(null);
    try {
      const res = await fetch(`${API_URL}/api/db-cards/health-check`, { method: 'POST' });
      if (res.ok) {
        const result = await res.json();
        setHealthResult(result);
        // チェック完了後にカードとstatsを再取得
        fetchCards(filter);
        fetchStats();
      }
    } catch { /* */ }
    setHealthChecking(false);
  }, [filter, fetchCards, fetchStats]);

  /** カードのフランチャイズに対応するタグオプションを取得 */
  const getTagOptionsForCard = (franchise: string): string[] => {
    return tagOptions[franchise] || [];
  };

  /** ソート済みカード */
  const sortedCards = (() => {
    if (sortBy === 'default') return cards;
    const sorted = [...cards].sort((a, b) => {
      const tagA = a.tag || '';
      const tagB = b.tag || '';
      if (!tagA && !tagB) return 0;
      if (!tagA) return 1;  // タグなしは後ろ
      if (!tagB) return -1;
      return sortBy === 'tag' ? tagA.localeCompare(tagB) : tagB.localeCompare(tagA);
    });
    return sorted;
  })();

  function cycleSortBy() {
    setSortBy(prev => {
      if (prev === 'default') return 'tag';
      if (prev === 'tag') return 'tag-desc';
      return 'default';
    });
  }

  return (
    <div>
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-8 sm:mb-14">
        <div>
          <h1 className="page-title text-2xl sm:text-4xl text-text-primary">DB管理</h1>
          <p className="text-sm sm:text-base text-text-secondary mt-2 sm:mt-3 flex flex-wrap gap-x-3 gap-y-0.5">
            <span>全カード: <span className="font-bold text-text-primary">{stats?.total ?? '-'}件</span></span>
            {stats?.errorCount ? (
              <span className="text-red-500 font-bold">エラー: {stats.errorCount}件</span>
            ) : null}
            {stats?.deadCount ? (
              <span className="text-orange-500 font-bold">リンク切れ: {stats.deadCount}件</span>
            ) : null}
          </p>
          <div className="flex flex-wrap items-center gap-2 sm:gap-3 mt-2">
            <button
              type="button"
              onClick={runHealthCheck}
              disabled={healthChecking}
              className="px-3 sm:px-4 py-1.5 text-xs font-medium bg-[#b8a080] text-white rounded-lg hover:bg-[#a08060] disabled:opacity-50 transition-colors whitespace-nowrap"
            >
              {healthChecking ? 'チェック中...' : '画像ヘルスチェック'}
            </button>
            <button
              type="button"
              onClick={cycleSortBy}
              className={`px-3 sm:px-4 py-1.5 text-xs font-medium rounded-lg border transition-colors whitespace-nowrap ${
                sortBy !== 'default'
                  ? 'bg-text-primary/10 border-text-primary/30 text-text-primary'
                  : 'border-border-card text-text-secondary hover:bg-warm-100'
              }`}
            >
              タグ順 {sortBy === 'tag' ? '↑' : sortBy === 'tag-desc' ? '↓' : ''}
            </button>
            {healthResult && (
              <span className="text-xs text-text-secondary">
                {healthResult.checked}件完了
                （OK: {healthResult.ok} / 切れ: <span className="text-red-500 font-bold">{healthResult.dead}</span>）
              </span>
            )}
          </div>
        </div>
        <FranchiseTabs
          active={filter}
          onChange={setFilter}
          extraTabs={[
            { key: 'error', label: 'エラー', badge: stats?.errorCount },
          ]}
        />
      </div>

      {loading ? (
        <p className="text-text-secondary">読み込み中...</p>
      ) : cards.length === 0 ? (
        <div className="bg-[#f3faf0] border border-[#bfd4b8] rounded-2xl p-10 text-center">
          <p className="text-[#2d5a2f] font-medium text-lg">
            {isErrorTab ? 'エラーのあるカードはありません' : '表示するカードがありません'}
          </p>
        </div>
      ) : (
        <>
          {/* Desktop: テーブル表示 */}
          <div className="hidden sm:block bg-card-bg border border-border-card rounded-2xl">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs font-bold uppercase tracking-[0.15em] text-text-secondary">
                  <th className="px-4 py-5 w-20">画像</th>
                  <th className="px-4 py-5">カード名</th>
                  <th className="px-4 py-5 w-20">グレード</th>
                  <th className="px-4 py-5 w-24">品番</th>
                  <th className="px-4 py-5 w-44">タグ</th>
                  <th className="px-4 py-5 w-48">代替画像URL</th>
                </tr>
              </thead>
              <tbody>
                {sortedCards.map((card) => (
                  <tr key={card.id} className="border-t border-border-card hover:bg-[#ded5cb] transition-colors">
                    <td className="px-4 py-3">
                      <div className="relative">
                        {card.image_url ? (
                          <img
                            src={card.image_url}
                            alt=""
                            className={`w-14 h-[78px] object-cover rounded-lg ${card.image_status === 'dead' ? 'opacity-40 border-2 border-red-400' : ''}`}
                            onError={(e) => {
                              if (card.alt_image_url && (e.target as HTMLImageElement).src !== card.alt_image_url) {
                                (e.target as HTMLImageElement).src = card.alt_image_url;
                              }
                            }}
                          />
                        ) : (
                          <div className="w-14 h-[78px] bg-red-50 border border-red-200 rounded-lg flex items-center justify-center">
                            <span className="text-red-400 text-xs">なし</span>
                          </div>
                        )}
                        {card.image_status === 'dead' && (
                          <span className="absolute -top-1 -right-1 bg-red-500 text-white text-[9px] font-bold px-1 rounded" title="リンク切れ">
                            DEAD
                          </span>
                        )}
                        {card.image_status === 'ok' && (
                          <span className="absolute -top-1 -right-1 bg-green-500 text-white text-[9px] font-bold px-1 rounded" title="OK">
                            OK
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <p className="font-semibold text-text-primary text-sm">{card.card_name}</p>
                      <p className="text-xs text-text-secondary mt-0.5">
                        {FRANCHISE_JA[card.franchise] || card.franchise}
                      </p>
                    </td>
                    <td className="px-4 py-3 text-text-secondary text-sm">{card.grade || '-'}</td>
                    <td className="px-4 py-3 text-text-secondary text-sm">{card.list_no || '-'}</td>
                    <td className="px-4 py-3">
                      <TagSelectCell
                        value={card.tag || ''}
                        options={getTagOptionsForCard(card.franchise)}
                        onSave={(v) => updateCard(card.id, 'tag', v)}
                      />
                    </td>
                    <td className="px-4 py-3">
                      <InlineEditCell
                        value={card.alt_image_url || ''}
                        placeholder="URL を入力"
                        onSave={(v) => updateCard(card.id, 'alt_image_url', v)}
                        renderDisplay={(v) =>
                          v ? (
                            <span className="text-green-600 text-xs font-medium truncate block max-w-[160px]" title={v}>
                              {v}
                            </span>
                          ) : (
                            <span className="text-text-secondary text-xs italic">未設定</span>
                          )
                        }
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Mobile: カード表示 */}
          <div className="sm:hidden space-y-2">
            {sortedCards.map((card) => (
              <div
                key={card.id}
                className="bg-card-bg border border-border-card rounded-xl p-3 active:bg-[#ded5cb] transition-colors cursor-pointer"
                onClick={() => setPreviewCard(card)}
              >
                <div className="flex gap-3">
                  {/* サムネイル + ステータス */}
                  <div className="relative flex-shrink-0">
                    {card.image_url ? (
                      <img
                        src={card.image_url}
                        alt=""
                        className={`w-12 h-[68px] object-cover rounded-lg ${card.image_status === 'dead' ? 'opacity-40 border-2 border-red-400' : ''}`}
                        onError={(e) => {
                          if (card.alt_image_url && (e.target as HTMLImageElement).src !== card.alt_image_url) {
                            (e.target as HTMLImageElement).src = card.alt_image_url;
                          }
                        }}
                      />
                    ) : (
                      <div className="w-12 h-[68px] bg-red-50 border border-red-200 rounded-lg flex items-center justify-center">
                        <span className="text-red-400 text-[10px]">なし</span>
                      </div>
                    )}
                    {card.image_status === 'dead' && (
                      <span className="absolute -top-1 -right-1 bg-red-500 text-white text-[8px] font-bold px-1 rounded">
                        DEAD
                      </span>
                    )}
                    {card.image_status === 'ok' && (
                      <span className="absolute -top-1 -right-1 bg-green-500 text-white text-[8px] font-bold px-1 rounded">
                        OK
                      </span>
                    )}
                  </div>

                  {/* カード情報 */}
                  <div className="flex-1 min-w-0">
                    <p className="font-semibold text-text-primary text-sm truncate">{card.card_name}</p>
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 mt-0.5">
                      <span className="text-[11px] text-text-secondary">{FRANCHISE_JA[card.franchise] || card.franchise}</span>
                      {card.grade && <span className="text-[11px] text-text-secondary">| {card.grade}</span>}
                      {card.list_no && <span className="text-[11px] text-text-secondary">| {card.list_no}</span>}
                    </div>

                    {/* タグ */}
                    <div className="mt-1.5" onClick={(e) => e.stopPropagation()}>
                      <TagSelectCell
                        value={card.tag || ''}
                        options={getTagOptionsForCard(card.franchise)}
                        onSave={(v) => updateCard(card.id, 'tag', v)}
                      />
                    </div>

                    {/* 代替画像URL */}
                    {(card.image_status === 'dead' || card.alt_image_url) && (
                      <div className="mt-1" onClick={(e) => e.stopPropagation()}>
                        <span className="text-[10px] text-text-secondary">代替URL: </span>
                        <InlineEditCell
                          value={card.alt_image_url || ''}
                          placeholder="URL を入力"
                          onSave={(v) => updateCard(card.id, 'alt_image_url', v)}
                          renderDisplay={(v) =>
                            v ? (
                              <span className="text-green-600 text-[11px] font-medium truncate block" title={v}>
                                {v}
                              </span>
                            ) : (
                              <span className="text-text-secondary text-[11px] italic">未設定</span>
                            )
                          }
                        />
                      </div>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {/* 画像プレビューモーダル */}
      {previewCard && (
        <div
          className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/60"
          onClick={() => setPreviewCard(null)}
        >
          <div
            className="bg-card-bg w-full sm:max-w-md sm:rounded-2xl rounded-t-2xl max-h-[85vh] flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            {/* 画像（高さ制限、全体が収まるように表示） */}
            <div className="relative bg-background flex-shrink-0 flex items-center justify-center rounded-t-2xl sm:rounded-t-2xl">
              {(previewCard.image_url || previewCard.alt_image_url) ? (
                <img
                  src={previewCard.alt_image_url || previewCard.image_url || ''}
                  alt={previewCard.card_name}
                  className="max-w-full max-h-[45vh] object-contain"
                  onError={(e) => {
                    if (previewCard.image_url && (e.target as HTMLImageElement).src !== previewCard.image_url) {
                      (e.target as HTMLImageElement).src = previewCard.image_url;
                    }
                  }}
                />
              ) : (
                <div className="w-full h-32 flex items-center justify-center bg-red-50">
                  <span className="text-red-400">画像なし</span>
                </div>
              )}
              {/* 閉じるボタン */}
              <button
                onClick={() => setPreviewCard(null)}
                className="absolute top-3 right-3 w-8 h-8 bg-black/50 text-white rounded-full flex items-center justify-center text-lg hover:bg-black/70"
              >
                ×
              </button>
              {/* ステータスバッジ */}
              {previewCard.image_status === 'dead' && (
                <span className="absolute top-3 left-3 bg-red-500 text-white text-xs font-bold px-2 py-0.5 rounded">
                  DEAD
                </span>
              )}
              {previewCard.image_status === 'ok' && (
                <span className="absolute top-3 left-3 bg-green-500 text-white text-xs font-bold px-2 py-0.5 rounded">
                  OK
                </span>
              )}
            </div>

            {/* カード詳細（スクロール可能） */}
            <div className="p-4 space-y-3 overflow-y-auto flex-1">
              {/* カード名 + 基本情報を横並び */}
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-bold text-text-primary text-base truncate">{previewCard.card_name}</p>
                  <p className="text-sm text-text-secondary mt-0.5">
                    {FRANCHISE_JA[previewCard.franchise] || previewCard.franchise}
                  </p>
                </div>
                <div className="flex gap-3 flex-shrink-0 text-sm">
                  {previewCard.grade && (
                    <div className="text-right">
                      <span className="text-text-secondary text-[10px] block">グレード</span>
                      <p className="text-text-primary font-medium">{previewCard.grade}</p>
                    </div>
                  )}
                  {previewCard.list_no && (
                    <div className="text-right">
                      <span className="text-text-secondary text-[10px] block">品番</span>
                      <p className="text-text-primary font-medium">{previewCard.list_no}</p>
                    </div>
                  )}
                </div>
              </div>

              {/* タグ・代替URL を横並びコンパクトに */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <span className="text-text-secondary text-[10px] block mb-1">タグ</span>
                  <TagSelectCell
                    value={previewCard.tag || ''}
                    options={getTagOptionsForCard(previewCard.franchise)}
                    onSave={async (v) => {
                      await updateCard(previewCard.id, 'tag', v);
                      setPreviewCard((prev) => prev ? { ...prev, tag: v || null } : null);
                    }}
                  />
                </div>
                <div>
                  <span className="text-text-secondary text-[10px] block mb-1">代替画像URL</span>
                  <InlineEditCell
                    value={previewCard.alt_image_url || ''}
                    placeholder="URL を入力"
                    onSave={async (v) => {
                      await updateCard(previewCard.id, 'alt_image_url', v);
                      setPreviewCard((prev) => prev ? { ...prev, alt_image_url: v || null } : null);
                    }}
                    renderDisplay={(v) =>
                      v ? (
                        <span className="text-green-600 text-xs font-medium truncate block" title={v}>
                          {v}
                        </span>
                      ) : (
                        <span className="text-text-secondary text-xs italic">未設定</span>
                      )
                    }
                  />
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
