import { createSupabaseClient } from './lib/supabase.js';

async function main() {
  const jobName = process.env.JOB_NAME || 'healthcheck';
  console.log(`[Haraka Job] Starting: ${jobName}`);

  try {
    switch (jobName) {
      case 'sync':
        console.log('sync job is not implemented yet (Phase 1)');
        break;
      case 'generate':
        console.log('generate job is not implemented yet (Phase 4)');
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
