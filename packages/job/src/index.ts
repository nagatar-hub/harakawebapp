import { createSupabaseClient } from './lib/supabase.js';
import { runSync } from './jobs/sync.js';
import { runGenerate } from './jobs/generate.js';
import { runRegeneratePage } from './jobs/regenerate-page.js';

/** SIGTERM を受けたらフラグを立てる（各ジョブが参照可能） */
export let abortRequested = false;

async function main() {
  const jobName = process.env.JOB_NAME || 'healthcheck';
  console.log(`[Haraka Job] Starting: ${jobName} (pid=${process.pid})`);

  // PID を running 中の最新 run に記録
  const supabase = createSupabaseClient();
  const { data: latestRun } = await supabase
    .from('run')
    .select('id')
    .eq('status', 'running')
    .order('started_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (latestRun) {
    await supabase.from('run').update({ process_pid: process.pid }).eq('id', latestRun.id);
  }

  // SIGTERM ハンドラ
  process.on('SIGTERM', () => {
    console.log(`[Haraka Job] SIGTERM received — aborting ${jobName}`);
    abortRequested = true;
    // 5秒待っても終了しなければ強制終了
    setTimeout(() => {
      console.error('[Haraka Job] Graceful shutdown timed out, forcing exit');
      process.exit(1);
    }, 5000);
  });

  try {
    switch (jobName) {
      case 'sync':
        await runSync();
        break;
      case 'generate':
        await runGenerate();
        break;
      case 'regenerate-page':
        await runRegeneratePage();
        break;
      case 'healthcheck':
        await runHealthcheck();
        break;
      default:
        throw new Error(`Unknown job: ${jobName}`);
    }
    console.log(`[Haraka Job] ${jobName} completed successfully`);
    process.exit(0);
  } catch (error) {
    if (abortRequested) {
      console.log(`[Haraka Job] ${jobName} aborted by user`);
      process.exit(0);
    }
    console.error(`[Haraka Job] ${jobName} failed:`, error);
    process.exit(1);
  }
}

async function runHealthcheck() {
  const supabase = createSupabaseClient();
  const { data, error } = await supabase.from('run').select('id').limit(1);
  if (error) throw new Error(`Supabase: ${error.message}`);
  console.log('Supabase: OK');
}

main();
