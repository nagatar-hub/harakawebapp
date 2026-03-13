import { Hono } from 'hono';
import { fork } from 'child_process';
import path from 'path';
import { createSupabaseClient } from '../lib/supabase.js';

export const galleryRoutes = new Hono();

/** 日付一覧: generated_page の created_at から DISTINCT 日付を抽出 */
galleryRoutes.get('/gallery/dates', async (c) => {
  const supabase = createSupabaseClient();

  // generated_page から run_id ごとの日付と件数を取得
  const { data: pages, error } = await supabase
    .from('generated_page')
    .select('run_id, franchise, image_key, created_at')
    .eq('status', 'generated')
    .order('created_at', { ascending: false });

  if (error) return c.json({ error: error.message }, 500);

  // image_key から日付を抽出: generated/YYYY/MM/DD/...
  const dateMap = new Map<string, Record<string, number>>();

  for (const p of pages || []) {
    const match = p.image_key?.match(/^generated\/(\d{4})\/(\d{2})\/(\d{2})\//);
    if (!match) continue;
    const dateStr = `${match[1]}-${match[2]}-${match[3]}`;
    if (!dateMap.has(dateStr)) dateMap.set(dateStr, {});
    const counts = dateMap.get(dateStr)!;
    counts[p.franchise] = (counts[p.franchise] || 0) + 1;
  }

  const dates = Array.from(dateMap.entries())
    .map(([date, franchises]) => ({ date, franchises }))
    .sort((a, b) => b.date.localeCompare(a.date));

  return c.json(dates);
});

/** 特定日の画像一覧（run情報付き） */
galleryRoutes.get('/gallery/images', async (c) => {
  const date = c.req.query('date'); // YYYY-MM-DD
  const franchise = c.req.query('franchise');

  if (!date) return c.json({ error: 'date is required' }, 400);

  const supabase = createSupabaseClient();
  const [year, month, day] = date.split('-');
  const prefix = `generated/${year}/${month}/${day}/`;

  let query = supabase
    .from('generated_page')
    .select('id, run_id, franchise, page_index, page_label, card_ids, image_key, image_url, status, created_at, run:run_id(started_at)')
    .eq('status', 'generated')
    .like('image_key', `${prefix}%`)
    .order('created_at', { ascending: false })
    .order('franchise')
    .order('page_index');

  if (franchise) {
    query = query.like('image_key', `${prefix}${franchise}%`);
  }

  const { data, error } = await query;
  if (error) return c.json({ error: error.message }, 500);

  // run情報をフラットに展開
  const pages = (data || []).map((p: Record<string, unknown>) => {
    const run = p.run as { started_at: string } | null;
    return {
      ...p,
      run_started_at: run?.started_at || p.created_at,
      run: undefined,
    };
  });

  return c.json(pages);
});

/** ページ詳細: generated_page + 紐づくカードデータ取得 */
galleryRoutes.get('/gallery/pages/:pageId', async (c) => {
  const pageId = c.req.param('pageId');
  const supabase = createSupabaseClient();

  const { data: page, error: pageErr } = await supabase
    .from('generated_page')
    .select('*')
    .eq('id', pageId)
    .single();

  if (pageErr || !page) return c.json({ error: 'Page not found' }, 404);

  // card_ids の順序を保持してカード取得
  const cardIds: string[] = (page as Record<string, unknown>).card_ids as string[] || [];
  if (cardIds.length === 0) return c.json({ page, cards: [] });

  const { data: cards, error: cardErr } = await supabase
    .from('prepared_card')
    .select('id, franchise, card_name, grade, list_no, image_url, alt_image_url, rarity, tag, price_high, price_low, image_status')
    .in('id', cardIds);

  if (cardErr) return c.json({ error: cardErr.message }, 500);

  // card_ids の並び順にソート
  const cardMap = new Map((cards || []).map(c => [c.id, c]));
  const orderedCards = cardIds.map(id => cardMap.get(id)).filter(Boolean);

  return c.json({ page, cards: orderedCards });
});

/** カードデータ更新 */
galleryRoutes.patch('/gallery/pages/:pageId/cards/:cardId', async (c) => {
  const { pageId, cardId } = c.req.param();
  const body = await c.req.json<{
    price_high?: number;
    price_low?: number;
    image_url?: string;
    alt_image_url?: string;
    tag?: string | null;
  }>();

  const supabase = createSupabaseClient();

  // ページに紐づくカードか確認
  const { data: page } = await supabase
    .from('generated_page')
    .select('card_ids')
    .eq('id', pageId)
    .single();

  if (!page || !((page as Record<string, unknown>).card_ids as string[] || []).includes(cardId)) {
    return c.json({ error: 'Card not found in this page' }, 404);
  }

  // 更新フィールドを構築
  const updates: Record<string, unknown> = {};
  if (body.price_high !== undefined) updates.price_high = body.price_high;
  if (body.price_low !== undefined) updates.price_low = body.price_low;
  if (body.image_url !== undefined) updates.image_url = body.image_url;
  if (body.alt_image_url !== undefined) updates.alt_image_url = body.alt_image_url;
  if (body.tag !== undefined) updates.tag = body.tag;

  if (Object.keys(updates).length === 0) {
    return c.json({ error: 'No fields to update' }, 400);
  }

  // 画像URL変更時はヘルスチェック
  if (body.image_url || body.alt_image_url) {
    const urlToCheck = body.image_url || body.alt_image_url;
    try {
      const r = await fetch(urlToCheck!, {
        method: 'HEAD',
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' },
        signal: AbortSignal.timeout(8000),
      });
      if (!r.ok && !(r.status === 403 && r.headers.get('cf-mitigated') === 'challenge')) {
        return c.json({ error: 'Image URL is not accessible', status: r.status }, 400);
      }
    } catch {
      return c.json({ error: 'Image URL is not reachable' }, 400);
    }
  }

  const { data: updated, error } = await supabase
    .from('prepared_card')
    .update(updates)
    .eq('id', cardId)
    .select()
    .single();

  if (error) return c.json({ error: error.message }, 500);

  return c.json(updated);
});

/** カード並び替え */
galleryRoutes.put('/gallery/pages/:pageId/reorder', async (c) => {
  const pageId = c.req.param('pageId');
  const { cardIds } = await c.req.json<{ cardIds: string[] }>();

  if (!Array.isArray(cardIds) || cardIds.length === 0) {
    return c.json({ error: 'cardIds array is required' }, 400);
  }

  const supabase = createSupabaseClient();

  const { data: page, error: pageErr } = await supabase
    .from('generated_page')
    .select('card_ids')
    .eq('id', pageId)
    .single();

  if (pageErr || !page) return c.json({ error: 'Page not found' }, 404);

  const currentIds = (page as Record<string, unknown>).card_ids as string[] || [];
  const currentSet = new Set(currentIds);
  const newSet = new Set(cardIds);
  if (currentSet.size !== newSet.size || ![...currentSet].every(id => newSet.has(id))) {
    return c.json({ error: 'cardIds must contain the same cards as current page' }, 400);
  }

  const { error } = await supabase
    .from('generated_page')
    .update({ card_ids: cardIds })
    .eq('id', pageId);

  if (error) return c.json({ error: error.message }, 500);

  return c.json({ status: 'ok', cardIds });
});

/** 単一ページ再生成 */
galleryRoutes.post('/gallery/pages/:pageId/regenerate', async (c) => {
  const pageId = c.req.param('pageId');
  const supabase = createSupabaseClient();

  // ページ情報取得
  const { data: page, error: pageErr } = await supabase
    .from('generated_page')
    .select('*')
    .eq('id', pageId)
    .single();

  if (pageErr || !page) return c.json({ error: 'Page not found' }, 404);

  // 子プロセスで再生成ジョブを起動（index.ts経由）
  const jobEntry = path.resolve(__dirname, '..', '..', '..', 'job', 'dist', 'index.js');

  const child = fork(jobEntry, [], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, JOB_NAME: 'regenerate-page', PAGE_ID: pageId },
  });
  child.unref();

  return c.json({ status: 'triggered', pageId, pid: child.pid });
});
