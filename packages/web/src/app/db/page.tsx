'use client';

import { useEffect, useState, useCallback } from 'react';
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
                <th className="px-4 py-5 w-36">タグ</th>
                <th className="px-4 py-5 w-20">代替画像</th>
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
                          // 代替画像があれば切り替え
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

                  {/* タグ */}
                  <td className="px-4 py-3">
                    {card.tag ? (
                      <span className="inline-block px-3 py-1 bg-text-primary/10 text-text-primary rounded-full text-xs font-medium">
                        {card.tag}
                      </span>
                    ) : (
                      <span className="inline-block px-3 py-1 bg-red-50 text-red-500 border border-red-200 rounded-full text-xs font-medium">
                        タグなし
                      </span>
                    )}
                  </td>

                  {/* 代替画像 */}
                  <td className="px-4 py-3">
                    {card.alt_image_url ? (
                      <span className="text-green-600 text-xs font-medium">あり</span>
                    ) : (
                      <span className="text-text-secondary text-xs">-</span>
                    )}
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
