import { Hono } from 'hono';
import { createSupabaseClient } from '../lib/supabase.js';
import { updateDbSheetCell } from '../lib/haraka-db-sheet.js';

export const dbCardRoutes = new Hono();

/** db_card 一覧取得（フランチャイズ・エラーフィルタ対応） */
dbCardRoutes.get('/db-cards', async (c) => {
  const franchise = c.req.query('franchise');
  const tab = c.req.query('tab'); // 'error' でエラーカードのみ
  const supabase = createSupabaseClient();

  let query = supabase
    .from('db_card')
    .select('id, franchise, tag, card_name, grade, list_no, image_url, alt_image_url, rarity_icon, sheet_row_number')
    .order('franchise')
    .order('card_name')
    .limit(2000);

  if (franchise && franchise !== 'all') {
    query = query.eq('franchise', franchise);
  }

  if (tab === 'error') {
    // エラー: tag が null OR image_url が null/空
    query = query.or('tag.is.null,image_url.is.null');
  }

  const { data, error } = await query;
  if (error) return c.json({ error: error.message }, 500);
  return c.json(data || []);
});

/** フランチャイズ別統計（件数 + エラー件数） */
dbCardRoutes.get('/db-cards/stats', async (c) => {
  const supabase = createSupabaseClient();

  // フランチャイズ別にカウント（1000件制限を回避）
  const franchises = ['Pokemon', 'ONE PIECE', 'YU-GI-OH!'];
  const byFranchise: Record<string, number> = {};
  let total = 0;
  let errorCount = 0;

  for (const f of franchises) {
    const { count: fCount } = await supabase
      .from('db_card')
      .select('*', { count: 'exact', head: true })
      .eq('franchise', f);
    byFranchise[f] = fCount ?? 0;
    total += fCount ?? 0;
  }

  // エラー件数: tag IS NULL OR image_url IS NULL
  const { count: errCount } = await supabase
    .from('db_card')
    .select('*', { count: 'exact', head: true })
    .or('tag.is.null,image_url.is.null');
  errorCount = errCount ?? 0;

  return c.json({ total, byFranchise, errorCount });
});

/** db_card 個別更新（tag / alt_image_url） + シート書き戻し */
dbCardRoutes.patch('/db-cards/:id', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json<{ tag?: string; alt_image_url?: string }>();
  const supabase = createSupabaseClient();

  // 更新対象フィールドを構築
  const updates: Record<string, string | null> = {};
  const sheetUpdates: { field: string; value: string }[] = [];

  if (body.tag !== undefined) {
    updates.tag = body.tag || null;
    sheetUpdates.push({ field: 'tag', value: body.tag || '' });
  }
  if (body.alt_image_url !== undefined) {
    updates.alt_image_url = body.alt_image_url || null;
    sheetUpdates.push({ field: 'alt_image_url', value: body.alt_image_url || '' });
  }

  if (Object.keys(updates).length === 0) {
    return c.json({ error: 'No fields to update' }, 400);
  }

  updates.updated_at = new Date().toISOString();

  // Supabase 更新
  const { data, error } = await supabase
    .from('db_card')
    .update(updates)
    .eq('id', id)
    .select('id, franchise, tag, card_name, grade, list_no, image_url, alt_image_url, rarity_icon, sheet_row_number')
    .single();

  if (error) return c.json({ error: error.message }, 500);
  if (!data) return c.json({ error: 'Card not found' }, 404);

  // シート書き戻し（非同期、エラーでもAPIレスポンスには影響しない）
  if (data.sheet_row_number) {
    for (const su of sheetUpdates) {
      updateDbSheetCell(data.sheet_row_number, su.field, su.value).catch((err) => {
        console.error(`[sheet] セル更新エラー: ${err.message}`);
      });
    }
  }

  return c.json(data);
});
