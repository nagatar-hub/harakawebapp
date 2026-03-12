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
};

type Stats = {
  total: number;
  byFranchise: Record<string, number>;
  errorCount: number;
};

const FRANCHISE_JA: Record<string, string> = {
  'Pokemon': 'ポケモン',
  'ONE PIECE': 'ワンピース',
  'YU-GI-OH!': '遊戯王',
};

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8080';

/** インライン編集セル */
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
      // 次ティックでfocusしないとrefがまだ無い場合がある
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
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('all');

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

  useEffect(() => {
    fetchCards(filter);
  }, [filter, fetchCards]);

  useEffect(() => {
    fetchStats();
  }, [fetchStats]);

  /** カード更新 PATCH */
  const updateCard = useCallback(async (id: string, field: 'tag' | 'alt_image_url', value: string) => {
    const res = await fetch(`${API_URL}/api/db-cards/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ [field]: value }),
    });
    if (!res.ok) throw new Error('更新に失敗しました');
    const updated: DbCard = await res.json();
    // ローカル state を更新
    setCards((prev) => prev.map((c) => (c.id === id ? updated : c)));
    // stats も再取得（エラー件数が変わる可能性）
    fetchStats();
  }, [fetchStats]);

  return (
    <div>
      <div className="flex items-center justify-between mb-14">
        <div>
          <h1 className="text-4xl font-bold text-text-primary tracking-tight">DB管理</h1>
          <p className="text-base text-text-secondary mt-3">
            全カード: <span className="font-bold text-text-primary">{stats?.total ?? '-'}件</span>
            {stats?.errorCount ? (
              <span className="ml-3 text-red-500 font-bold">エラー: {stats.errorCount}件</span>
            ) : null}
          </p>
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
        <div className="bg-card-bg border border-border-card rounded-2xl overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs font-bold uppercase tracking-[0.15em] text-text-secondary">
                <th className="px-4 py-5 w-20">画像</th>
                <th className="px-4 py-5">カード名</th>
                <th className="px-4 py-5 w-20">グレード</th>
                <th className="px-4 py-5 w-24">品番</th>
                <th className="px-4 py-5 w-44">タグ</th>
                <th className="px-4 py-5 w-48">代替画像URL</th>
                <th className="px-4 py-5 w-16">レア</th>
              </tr>
            </thead>
            <tbody>
              {cards.map((card) => (
                <tr key={card.id} className="border-t border-border-card hover:bg-[#ded5cb] transition-colors">
                  {/* 画像 */}
                  <td className="px-4 py-3">
                    {card.image_url ? (
                      <img
                        src={card.image_url}
                        alt=""
                        className="w-14 h-[78px] object-cover rounded-lg"
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
                  </td>

                  {/* カード名 + フランチャイズ */}
                  <td className="px-4 py-3">
                    <p className="font-semibold text-text-primary text-sm">{card.card_name}</p>
                    <p className="text-xs text-text-secondary mt-0.5">
                      {FRANCHISE_JA[card.franchise] || card.franchise}
                    </p>
                  </td>

                  {/* グレード */}
                  <td className="px-4 py-3 text-text-secondary text-sm">{card.grade || '-'}</td>

                  {/* 品番 */}
                  <td className="px-4 py-3 text-text-secondary text-sm">{card.list_no || '-'}</td>

                  {/* タグ（インライン編集） */}
                  <td className="px-4 py-3">
                    <InlineEditCell
                      value={card.tag || ''}
                      placeholder="タグを入力"
                      onSave={(v) => updateCard(card.id, 'tag', v)}
                      renderDisplay={(v) =>
                        v ? (
                          <span className="inline-block px-3 py-1 bg-text-primary/10 text-text-primary rounded-full text-xs font-medium">
                            {v}
                          </span>
                        ) : (
                          <span className="inline-block px-3 py-1 bg-red-50 text-red-500 border border-red-200 rounded-full text-xs font-medium">
                            タグなし
                          </span>
                        )
                      }
                    />
                  </td>

                  {/* 代替画像URL（インライン編集） */}
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

                  {/* レアリティ */}
                  <td className="px-4 py-3">
                    {card.rarity_icon ? (
                      <img src={card.rarity_icon} alt="" className="w-5 h-5" />
                    ) : (
                      <span className="text-text-secondary text-xs">-</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
