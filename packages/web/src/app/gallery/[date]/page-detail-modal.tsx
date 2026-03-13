'use client';

import { useEffect, useState } from 'react';
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
  useSortable,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

type CardDetail = {
  id: string;
  franchise: string;
  card_name: string;
  grade: string | null;
  list_no: string | null;
  image_url: string | null;
  alt_image_url: string | null;
  rarity: string | null;
  tag: string | null;
  price_high: number | null;
  price_low: number | null;
  image_status: string | null;
};

type PageDetail = {
  id: string;
  run_id: string;
  franchise: string;
  page_index: number;
  page_label: string | null;
  card_ids: string[];
  image_key: string | null;
  image_url: string | null;
  status: string;
};

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8080';

function formatPrice(val: number | null): string {
  if (val == null) return '-';
  return `¥${val.toLocaleString()}`;
}

/* ─── Card Edit Popup ─── */
function CardEditPopup({
  card,
  onSave,
  onClose,
}: {
  card: CardDetail;
  onSave: (cardId: string, updates: Record<string, unknown>) => Promise<boolean>;
  onClose: () => void;
}) {
  const [tag, setTag] = useState(card.tag || '');
  const [priceHigh, setPriceHigh] = useState(card.price_high?.toString() || '');
  const [priceLow, setPriceLow] = useState(card.price_low?.toString() || '');
  const [altImageUrl, setAltImageUrl] = useState(card.alt_image_url || '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSave() {
    setError(null);
    const updates: Record<string, unknown> = {};

    const highNum = parseFloat(priceHigh.replace(/[¥,]/g, ''));
    const lowNum = parseFloat(priceLow.replace(/[¥,]/g, ''));

    if (priceHigh && isNaN(highNum)) {
      setError('価格(高)に有効な数値を入力してください');
      return;
    }
    if (priceLow && isNaN(lowNum)) {
      setError('価格(低)に有効な数値を入力してください');
      return;
    }

    if (priceHigh) updates.price_high = highNum;
    else if (priceHigh === '' && card.price_high != null) updates.price_high = null;

    if (priceLow) updates.price_low = lowNum;
    else if (priceLow === '' && card.price_low != null) updates.price_low = null;

    if (altImageUrl !== (card.alt_image_url || '')) {
      updates.alt_image_url = altImageUrl || null;
    }

    if (tag !== (card.tag || '')) {
      updates.tag = tag || null;
    }

    if (Object.keys(updates).length === 0) {
      onClose();
      return;
    }

    setSaving(true);
    const ok = await onSave(card.id, updates);
    setSaving(false);
    if (ok) onClose();
    else setError('保存に失敗しました');
  }

  return (
    <div className="fixed inset-0 z-[60] bg-black/50 flex items-center justify-center p-4" onClick={onClose}>
      <div
        className="bg-page-bg rounded-2xl border border-border-card shadow-2xl w-full max-w-md overflow-hidden"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-border-card bg-warm-50">
          <h3 className="text-base font-bold text-text-primary truncate">
            {card.card_name}
          </h3>
          <button
            onClick={onClose}
            className="w-7 h-7 rounded-full bg-warm-200 text-text-secondary hover:bg-warm-300 flex items-center justify-center text-sm"
          >
            ×
          </button>
        </div>

        <div className="p-5 space-y-4">
          {/* Card image + info */}
          <div className="flex gap-4">
            <div className="w-20 h-28 rounded-lg border border-border-card bg-warm-100 overflow-hidden flex-shrink-0">
              {(card.alt_image_url || card.image_url) ? (
                <img
                  src={card.alt_image_url || card.image_url || ''}
                  alt=""
                  className="w-full h-full object-contain"
                  onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }}
                />
              ) : (
                <span className="text-xs text-text-secondary flex items-center justify-center h-full">No Image</span>
              )}
            </div>
            <div className="flex-1 text-sm space-y-1">
              <div className="text-text-secondary">
                {card.grade && <span className="mr-2">{card.grade}</span>}
                {card.list_no && <span>{card.list_no}</span>}
              </div>
              {card.tag && (
                <span className="inline-block text-xs px-2 py-0.5 rounded-full bg-warm-100 text-text-secondary">
                  {card.tag}
                </span>
              )}
              {card.image_status && card.image_status !== 'ok' && (
                <div className={`text-xs ${card.image_status === 'dead' ? 'text-red-500' : 'text-yellow-600'}`}>
                  画像: {card.image_status}
                </div>
              )}
            </div>
          </div>

          {/* Error */}
          {error && (
            <div className="px-3 py-2 rounded-lg text-sm bg-red-50 text-red-700 border border-red-200">
              {error}
            </div>
          )}

          {/* Editable fields */}
          <div className="space-y-3">
            <div>
              <label className="block text-xs font-medium text-text-secondary mb-1">タグ</label>
              <input
                type="text"
                value={tag}
                onChange={e => setTag(e.target.value)}
                className="w-full px-3 py-2 border border-border-card rounded-lg bg-white text-sm text-text-primary"
                placeholder="例: V/SA"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-text-secondary mb-1">価格（高）</label>
              <input
                type="text"
                value={priceHigh}
                onChange={e => setPriceHigh(e.target.value)}
                className="w-full px-3 py-2 border border-border-card rounded-lg bg-white text-sm text-text-primary"
                placeholder="例: 5000"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-text-secondary mb-1">価格（低）</label>
              <input
                type="text"
                value={priceLow}
                onChange={e => setPriceLow(e.target.value)}
                className="w-full px-3 py-2 border border-border-card rounded-lg bg-white text-sm text-text-primary"
                placeholder="例: 3000"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-text-secondary mb-1">代替画像URL</label>
              <input
                type="text"
                value={altImageUrl}
                onChange={e => setAltImageUrl(e.target.value)}
                className="w-full px-3 py-2 border border-border-card rounded-lg bg-white text-sm text-text-primary"
                placeholder="https://..."
              />
            </div>
          </div>

          {/* Actions */}
          <div className="flex gap-2 pt-1">
            <button
              onClick={onClose}
              className="flex-1 px-4 py-2 rounded-full text-sm font-medium border border-border-card text-text-secondary hover:bg-warm-100 transition-colors"
            >
              キャンセル
            </button>
            <button
              onClick={handleSave}
              disabled={saving}
              className="flex-1 px-4 py-2 rounded-full text-sm font-semibold bg-text-primary text-white hover:bg-warm-800 active:scale-95 transition-all disabled:opacity-50"
            >
              {saving ? '保存中...' : '保存'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ─── Sortable Row ─── */
function SortableRow({
  card,
  idx,
  onClick,
}: {
  card: CardDetail;
  idx: number;
  onClick: () => void;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: card.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
    zIndex: isDragging ? 50 : undefined,
  };

  return (
    <tr
      ref={setNodeRef}
      style={style}
      className={`border-b border-border-card/50 last:border-0 hover:bg-warm-100 transition-colors ${isDragging ? 'bg-warm-200' : ''}`}
    >
      <td className="py-2 pr-1 w-8">
        <button
          {...attributes}
          {...listeners}
          className="cursor-grab active:cursor-grabbing p-1 text-text-secondary hover:text-text-primary"
          title="ドラッグして並べ替え"
        >
          ⠿
        </button>
      </td>
      <td className="py-2 pr-2 text-text-secondary cursor-pointer" onClick={onClick}>{idx + 1}</td>
      <td className="py-2 pr-2 cursor-pointer" onClick={onClick}>
        <div className="w-10 h-14 rounded border border-border-card bg-warm-100 overflow-hidden">
          {(card.alt_image_url || card.image_url) ? (
            <img
              src={card.alt_image_url || card.image_url || ''}
              alt=""
              className="w-full h-full object-contain"
              onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }}
            />
          ) : (
            <span className="text-[10px] text-text-secondary flex items-center justify-center h-full">-</span>
          )}
        </div>
      </td>
      <td className="py-2 pr-2 cursor-pointer" onClick={onClick}>
        <span className="text-text-primary font-medium">{card.card_name}</span>
        <br />
        <span className="text-xs text-text-secondary">{card.grade || ''} {card.list_no || ''}</span>
      </td>
      <td className="py-2 pr-2 cursor-pointer" onClick={onClick}>
        <span className="text-xs px-2 py-0.5 rounded-full bg-warm-100 text-text-secondary">
          {card.tag || '-'}
        </span>
      </td>
      <td className="py-2 pr-2 text-right text-text-primary cursor-pointer" onClick={onClick}>
        {formatPrice(card.price_high)}
      </td>
      <td className="py-2 pr-2 text-right text-text-primary cursor-pointer" onClick={onClick}>
        {formatPrice(card.price_low)}
      </td>
      <td className="py-2 cursor-pointer" onClick={onClick}>
        {card.image_status === 'dead' ? (
          <span className="text-xs text-red-500">dead</span>
        ) : card.image_status === 'fallback' ? (
          <span className="text-xs text-yellow-600">代替</span>
        ) : card.alt_image_url ? (
          <span className="text-xs text-green-600">代替設定済</span>
        ) : (
          <span className="text-xs text-text-secondary">OK</span>
        )}
      </td>
    </tr>
  );
}

/* ─── Page Detail Modal ─── */
export function PageDetailModal({
  pageId,
  onClose,
  onRegenerated,
}: {
  pageId: string;
  onClose: () => void;
  onRegenerated?: () => void;
}) {
  const [page, setPage] = useState<PageDetail | null>(null);
  const [cards, setCards] = useState<CardDetail[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingCardId, setEditingCardId] = useState<string | null>(null);
  const [regenerating, setRegenerating] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  useEffect(() => {
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = ''; };
  }, []);

  useEffect(() => {
    loadPageDetail();
  }, [pageId]);

  async function loadPageDetail() {
    setLoading(true);
    try {
      const res = await fetch(`${API_URL}/api/gallery/pages/${pageId}`);
      if (res.ok) {
        const data = await res.json();
        setPage(data.page);
        setCards(data.cards);
      }
    } catch {
      // ignore
    }
    setLoading(false);
  }

  async function saveCard(cardId: string, updates: Record<string, unknown>): Promise<boolean> {
    try {
      const res = await fetch(`${API_URL}/api/gallery/pages/${pageId}/cards/${cardId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates),
      });
      if (res.ok) {
        const updated = await res.json();
        setCards(prev => prev.map(c => c.id === cardId ? { ...c, ...updated } : c));
        setMessage({ type: 'success', text: '保存しました' });
        setTimeout(() => setMessage(null), 3000);
        return true;
      } else {
        const err = await res.json();
        setMessage({ type: 'error', text: err.error || '保存に失敗しました' });
        return false;
      }
    } catch {
      setMessage({ type: 'error', text: 'ネットワークエラー' });
      return false;
    }
  }

  async function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const oldIndex = cards.findIndex(c => c.id === active.id);
    const newIndex = cards.findIndex(c => c.id === over.id);
    if (oldIndex === -1 || newIndex === -1) return;

    const newCards = arrayMove(cards, oldIndex, newIndex);
    setCards(newCards);

    try {
      const res = await fetch(`${API_URL}/api/gallery/pages/${page?.id}/reorder`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cardIds: newCards.map(c => c.id) }),
      });
      if (res.ok) {
        setMessage({ type: 'success', text: '並び順を保存しました' });
        setTimeout(() => setMessage(null), 2000);
      } else {
        setCards(cards);
        setMessage({ type: 'error', text: '並べ替えの保存に失敗しました' });
      }
    } catch {
      setCards(cards);
      setMessage({ type: 'error', text: 'ネットワークエラー' });
    }
  }

  async function handleRegenerate() {
    setRegenerating(true);
    setMessage(null);
    try {
      const res = await fetch(`${API_URL}/api/gallery/pages/${pageId}/regenerate`, {
        method: 'POST',
      });
      if (res.ok) {
        setMessage({ type: 'success', text: '再生成を開始しました。しばらくお待ちください...' });
        setTimeout(async () => {
          await loadPageDetail();
          setRegenerating(false);
          onRegenerated?.();
        }, 10000);
      } else {
        setMessage({ type: 'error', text: '再生成の開始に失敗しました' });
        setRegenerating(false);
      }
    } catch {
      setMessage({ type: 'error', text: 'ネットワークエラー' });
      setRegenerating(false);
    }
  }

  const editingCard = editingCardId ? cards.find(c => c.id === editingCardId) : null;

  return (
    <>
      <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4" onClick={onClose}>
        <div
          className="bg-page-bg rounded-2xl border border-border-card shadow-2xl max-w-5xl w-full max-h-[90vh] overflow-hidden flex flex-col"
          onClick={e => e.stopPropagation()}
        >
          {/* Header */}
          <div className="flex items-center justify-between px-6 py-4 border-b border-border-card">
            <div>
              <h2 className="text-xl font-bold text-text-primary">
                {page?.page_label || `page-${page?.page_index}`}
              </h2>
              <p className="text-sm text-text-secondary mt-0.5">
                {page?.franchise} · {cards.length}枚
              </p>
            </div>
            <div className="flex items-center gap-3">
              <button
                onClick={handleRegenerate}
                disabled={regenerating}
                className={`px-4 py-2 rounded-full text-sm font-semibold transition-all duration-100 ${
                  regenerating
                    ? 'bg-blue-600 text-white cursor-wait'
                    : 'bg-text-primary text-white hover:bg-warm-800 active:scale-90'
                }`}
              >
                {regenerating ? (
                  <span className="flex items-center gap-2">
                    <span className="inline-block w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                    再生成中...
                  </span>
                ) : '再生成'}
              </button>
              <button
                onClick={onClose}
                className="w-8 h-8 rounded-full bg-warm-200 text-text-secondary hover:bg-warm-300 flex items-center justify-center text-lg"
              >
                ×
              </button>
            </div>
          </div>

          {/* Message */}
          {message && (
            <div className={`mx-6 mt-3 px-4 py-2 rounded-lg text-sm ${
              message.type === 'success'
                ? 'bg-[#f3faf0] text-[#2d5a2f] border border-[#bfd4b8]'
                : 'bg-red-50 text-red-700 border border-red-200'
            }`}>
              {message.text}
            </div>
          )}

          {/* Content */}
          <div className="flex-1 overflow-y-auto p-6">
            {loading ? (
              <p className="text-text-secondary">読み込み中...</p>
            ) : (
              <div className="flex gap-6">
                {/* Left: Page preview */}
                {page?.image_url && (
                  <div className="flex-shrink-0 w-64">
                    <img
                      src={`${page.image_url}?t=${Date.now()}`}
                      alt={page.page_label || ''}
                      className="w-full rounded-xl border border-border-card"
                    />
                  </div>
                )}

                {/* Right: Card table */}
                <div className="flex-1 min-w-0">
                  <p className="text-xs text-text-secondary mb-2">カードをクリックして編集 · ⠿をドラッグで並べ替え</p>
                  <DndContext
                    sensors={sensors}
                    collisionDetection={closestCenter}
                    onDragEnd={handleDragEnd}
                  >
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="text-left text-text-secondary border-b border-border-card">
                          <th className="pb-2 pr-1 w-8"></th>
                          <th className="pb-2 pr-2 w-8">#</th>
                          <th className="pb-2 pr-2">画像</th>
                          <th className="pb-2 pr-2">カード名</th>
                          <th className="pb-2 pr-2">タグ</th>
                          <th className="pb-2 pr-2 text-right">価格(高)</th>
                          <th className="pb-2 pr-2 text-right">価格(低)</th>
                          <th className="pb-2">状態</th>
                        </tr>
                      </thead>
                      <SortableContext
                        items={cards.map(c => c.id)}
                        strategy={verticalListSortingStrategy}
                      >
                        <tbody>
                          {cards.map((card, idx) => (
                            <SortableRow
                              key={card.id}
                              card={card}
                              idx={idx}
                              onClick={() => setEditingCardId(card.id)}
                            />
                          ))}
                        </tbody>
                      </SortableContext>
                    </table>
                  </DndContext>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Card Edit Popup */}
      {editingCard && (
        <CardEditPopup
          card={editingCard}
          onSave={saveCard}
          onClose={() => setEditingCardId(null)}
        />
      )}
    </>
  );
}
