'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { FranchiseTabs } from '@/components/franchise-tabs';
import { ImageModal } from '@/components/image-modal';
import { PageDetailModal } from './page-detail-modal';

type PageImage = {
  id: string;
  run_id: string;
  franchise: string;
  page_index: number;
  page_label: string | null;
  card_ids: string[];
  image_url: string | null;
  run_started_at: string;
};

const FRANCHISE_JA: Record<string, string> = {
  'Pokemon': 'ポケモン',
  'ONE PIECE': 'ワンピース',
  'YU-GI-OH!': '遊戯王',
};

function formatTime(iso: string) {
  return new Date(iso).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export default function GalleryDatePage() {
  const { date } = useParams<{ date: string }>();
  const [images, setImages] = useState<PageImage[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('all');
  const [modalIndex, setModalIndex] = useState<number | null>(null);
  const [collapsedRuns, setCollapsedRuns] = useState<Set<string>>(new Set());
  const [detailPageId, setDetailPageId] = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      setLoading(true);
      const apiUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8080';
      try {
        const res = await fetch(`${apiUrl}/api/gallery/images?date=${date}`);
        if (res.ok) {
          const data: PageImage[] = await res.json();
          setImages(data);

          // 最新run以外を折りたたむ
          const runIds = [...new Set(data.map(d => d.run_id))];
          if (runIds.length > 1) {
            // run_started_at降順で最初のrun_idが最新
            const sorted = [...new Map(data.map(d => [d.run_id, d.run_started_at]))].sort((a, b) => b[1].localeCompare(a[1]));
            const oldRuns = new Set(sorted.slice(1).map(s => s[0]));
            setCollapsedRuns(oldRuns);
          }
        }
      } catch {
        // ignore
      }
      setLoading(false);
    }
    load();
  }, [date]);

  const filtered = filter === 'all'
    ? images
    : images.filter((img) => img.franchise === filter);

  // run_id単位でグループ化（最新順）
  const runGroups = (() => {
    const map = new Map<string, { started_at: string; pages: PageImage[] }>();
    for (const img of filtered) {
      if (!map.has(img.run_id)) {
        map.set(img.run_id, { started_at: img.run_started_at, pages: [] });
      }
      map.get(img.run_id)!.pages.push(img);
    }
    return [...map.entries()].sort((a, b) => b[1].started_at.localeCompare(a[1].started_at));
  })();

  const hasMultipleRuns = runGroups.length > 1;

  function toggleRun(runId: string) {
    setCollapsedRuns(prev => {
      const next = new Set(prev);
      if (next.has(runId)) next.delete(runId);
      else next.add(runId);
      return next;
    });
  }

  // 全filtered画像のフラット配列（モーダル用）
  const allFiltered = runGroups.flatMap(([, g]) => g.pages);

  return (
    <div>
      <div className="flex items-center justify-between mb-14">
        <div>
          <h1 className="text-4xl font-bold text-text-primary tracking-tight">{date}</h1>
        </div>
        <FranchiseTabs active={filter} onChange={setFilter} />
      </div>

      {loading ? (
        <p className="text-text-secondary">読み込み中...</p>
      ) : filtered.length === 0 ? (
        <p className="text-text-secondary">画像がありません</p>
      ) : (
        <>
          {runGroups.map(([runId, group], runIdx) => {
            const isCollapsed = collapsedRuns.has(runId);
            // runGroupsのstartIdxを計算（モーダルナビ用）
            let startIdx = 0;
            for (let i = 0; i < runIdx; i++) startIdx += runGroups[i][1].pages.length;

            // franchise別にグループ化
            const franchiseGroups = new Map<string, PageImage[]>();
            for (const img of group.pages) {
              const list = franchiseGroups.get(img.franchise) || [];
              list.push(img);
              franchiseGroups.set(img.franchise, list);
            }

            return (
              <div key={runId} className="mb-10">
                {/* Run header（複数実行がある場合のみ表示） */}
                {hasMultipleRuns && (
                  <button
                    onClick={() => toggleRun(runId)}
                    className="flex items-center gap-3 mb-5 group"
                  >
                    <span className="text-sm text-text-secondary">
                      {isCollapsed ? '▶' : '▼'}
                    </span>
                    <span className="text-base font-semibold text-text-primary">
                      {formatTime(group.started_at)} の実行
                    </span>
                    <span className="text-sm text-text-secondary">
                      ({group.pages.length}ページ)
                    </span>
                    {runIdx === 0 && (
                      <span className="text-xs px-2 py-0.5 rounded-full bg-[#f3faf0] text-[#2d5a2f] border border-[#bfd4b8]">最新</span>
                    )}
                  </button>
                )}

                {!isCollapsed && Array.from(franchiseGroups.entries()).map(([franchise, pages]) => {
                  const franchiseStart = startIdx + group.pages.indexOf(pages[0]);
                  return (
                    <div key={`${runId}-${franchise}`} className="mb-12">
                      <h2 className="text-2xl font-bold text-text-primary mb-5">
                        {FRANCHISE_JA[franchise] || franchise}
                        <span className="text-base text-text-secondary font-normal ml-3">{pages.length}ページ</span>
                      </h2>
                      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-6">
                        {pages.map((page, i) => (
                          <div key={page.id} className="bg-card-bg border border-border-card rounded-xl overflow-hidden hover:scale-[1.03] transition-transform duration-300">
                            <button
                              onClick={() => setModalIndex(franchiseStart + i)}
                              className="w-full text-left"
                            >
                              {page.image_url && (
                                <img src={page.image_url} alt={page.page_label || ''} className="w-full h-auto" loading="lazy" />
                              )}
                            </button>
                            <div className="px-4 py-3 flex items-center justify-between">
                              <div>
                                <p className="text-base font-semibold text-text-primary truncate">{page.page_label || `page-${page.page_index}`}</p>
                                <p className="text-sm text-text-secondary mt-0.5">{page.card_ids.length}枚</p>
                              </div>
                              <button
                                onClick={(e) => { e.stopPropagation(); setDetailPageId(page.id); }}
                                className="text-xs px-3 py-1.5 rounded-lg border border-border-card text-text-secondary hover:bg-warm-100 hover:text-text-primary transition-colors"
                                title="データ詳細"
                              >
                                詳細
                              </button>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            );
          })}
        </>
      )}

      {modalIndex !== null && (
        <ImageModal
          images={allFiltered}
          currentIndex={modalIndex}
          onClose={() => setModalIndex(null)}
          onNavigate={setModalIndex}
        />
      )}

      {detailPageId && (
        <PageDetailModal
          pageId={detailPageId}
          onClose={() => setDetailPageId(null)}
          onRegenerated={() => {
            // 再生成後に画像一覧をリロード
            const apiUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8080';
            fetch(`${apiUrl}/api/gallery/images?date=${date}`)
              .then(r => r.json())
              .then(data => setImages(data))
              .catch(() => {});
          }}
        />
      )}
    </div>
  );
}
