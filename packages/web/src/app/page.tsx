import { createClient } from '@supabase/supabase-js';

export const dynamic = 'force-dynamic';

export default async function DashboardPage() {
  let supabaseStatus = 'checking...';
  let latestRun = null;
  let apiStatus = 'unknown';

  // Supabase接続チェック
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (url && key) {
    try {
      const supabase = createClient(url, key);
      const { data, error } = await supabase
        .from('run')
        .select('*')
        .order('started_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      supabaseStatus = error ? `Error: ${error.message}` : 'Connected';
      latestRun = data;
    } catch (e) {
      supabaseStatus = `Error: ${(e as Error).message}`;
    }
  } else {
    supabaseStatus = 'Not configured (missing env vars)';
  }

  // API接続チェック
  const apiUrl = process.env.NEXT_PUBLIC_API_URL;
  if (apiUrl) {
    try {
      const res = await fetch(`${apiUrl}/api/health`, { cache: 'no-store' });
      const json = await res.json();
      apiStatus = json.status || 'unknown';
    } catch {
      apiStatus = 'unreachable';
    }
  } else {
    apiStatus = 'Not configured';
  }

  return (
    <main className="max-w-4xl mx-auto p-8">
      <h1 className="text-3xl font-bold mb-8">Haraka Dashboard</h1>

      <div className="grid gap-4">
        <div className="bg-white rounded-lg shadow p-6">
          <h2 className="text-lg font-semibold mb-2">Supabase</h2>
          <p className={supabaseStatus === 'Connected' ? 'text-green-600 font-medium' : 'text-red-600'}>
            {supabaseStatus}
          </p>
        </div>

        <div className="bg-white rounded-lg shadow p-6">
          <h2 className="text-lg font-semibold mb-2">Cloud Run API</h2>
          <p className={apiStatus === 'healthy' ? 'text-green-600 font-medium' : 'text-yellow-600'}>
            {apiStatus}
          </p>
          {apiUrl && <p className="text-sm text-gray-400 mt-1">{apiUrl}</p>}
        </div>

        <div className="bg-white rounded-lg shadow p-6">
          <h2 className="text-lg font-semibold mb-2">Latest Run</h2>
          {latestRun ? (
            <pre className="text-xs bg-gray-100 p-3 rounded overflow-auto">
              {JSON.stringify(latestRun, null, 2)}
            </pre>
          ) : (
            <p className="text-gray-500">No runs yet</p>
          )}
        </div>
      </div>
    </main>
  );
}
