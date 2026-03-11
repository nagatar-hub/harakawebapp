import { Hono } from 'hono';
import { createSupabaseClient } from '../lib/supabase.js';
import type { Database } from '@haraka/shared';

type RuleInsert = Database['public']['Tables']['rule']['Insert'];
type RuleUpdate = Database['public']['Tables']['rule']['Update'];

export const ruleRoutes = new Hono();

ruleRoutes.get('/rules', async (c) => {
  const supabase = createSupabaseClient();
  const { data, error } = await supabase.from('rule').select('*').order('priority', { ascending: false });
  if (error) return c.json({ error: error.message }, 500);
  return c.json(data);
});

ruleRoutes.post('/rules', async (c) => {
  const body = await c.req.json<RuleInsert>();
  const supabase = createSupabaseClient();
  const { data, error } = await supabase.from('rule').insert(body).select().single();
  if (error) return c.json({ error: error.message }, 500);
  return c.json(data, 201);
});

ruleRoutes.patch('/rules/:id', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json<RuleUpdate>();
  const supabase = createSupabaseClient();
  const { data, error } = await supabase.from('rule').update(body).eq('id', id).select().single();
  if (error) return c.json({ error: error.message }, 500);
  return c.json(data);
});

ruleRoutes.delete('/rules/:id', async (c) => {
  const id = c.req.param('id');
  const supabase = createSupabaseClient();
  const { error } = await supabase.from('rule').delete().eq('id', id);
  if (error) return c.json({ error: error.message }, 500);
  return c.json({ ok: true });
});
