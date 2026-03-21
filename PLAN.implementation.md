# 実装計画：ジョブ監視強化（3項目）

## 1. Generate 完了通知に失敗ページ数を含める

### 目的
Generate ジョブが「完了」と通知されても、一部ページが `status='failed'` になっているケースを見逃さない。

### 変更ファイル
- `packages/job/src/jobs/generate.ts`

### 変更内容
- ジョブ完了時（L436-457）に、`generated_page` テーブルから `status='failed'` のページ数を集計する
- 失敗ページが1件以上ある場合：
  - 通知タイトルを `🟡 Generate ジョブ完了（一部失敗あり）` に変更
  - 色を `COLOR.WARNING`（黄）に変更
  - フィールドに「失敗ページ数」を追加
- 失敗ページが0件の場合：従来通り `🟢 Generate ジョブ完了`（緑）

### 実装イメージ
```typescript
// L436 の後に追加
const { count: failedPageCount } = await supabase
  .from('generated_page')
  .select('*', { count: 'exact', head: true })
  .eq('run_id', run.id)
  .eq('status', 'failed');

const failedPages = failedPageCount ?? 0;
const hasFailures = failedPages > 0;

await sendDiscordNotification({
  title: hasFailures ? '🟡 Generate ジョブ完了（一部失敗あり）' : '🟢 Generate ジョブ完了',
  color: hasFailures ? COLOR.WARNING : COLOR.SUCCESS,
  fields: [
    { name: '生成ページ数', value: `${totalPages}ページ`, inline: true },
    ...(hasFailures ? [{ name: '失敗ページ', value: `${failedPages}ページ`, inline: true }] : []),
    { name: '所要時間', value: `${elapsed}秒`, inline: true },
  ],
});
```

---

## 2. Cloud Scheduler 失敗時の GCP Monitoring アラート設定

### 目的
Cloud Scheduler がジョブ起動に失敗した場合（権限エラー、API障害等）、Discord に通知が飛ばないため、GCP Monitoring のアラートポリシーで検知する。

### 対応方法
GCP コンソールまたは gcloud CLI で設定。コード変更は不要。

### 設定内容
```bash
# Cloud Scheduler の実行失敗を検知するアラートポリシー
gcloud alpha monitoring policies create \
  --display-name="Cloud Scheduler Job Failure" \
  --condition-display-name="Scheduler execution failed" \
  --condition-filter='resource.type="cloud_scheduler_job" AND metric.type="cloud_scheduler.googleapis.com/job/attempt_count" AND metric.labels.status!="success"' \
  --condition-threshold-value=1 \
  --condition-threshold-duration=0s \
  --notification-channels=<CHANNEL_ID>
```

### 手動設定手順（GCPコンソール）
1. Cloud Monitoring → アラートポリシー → 新規作成
2. 条件: `cloud_scheduler.googleapis.com/job/attempt_count` で `status != success`
3. 通知チャネル: メール（nagata.r@tomstocks.net）を設定
4. ドキュメント: 「Cloud Scheduler のジョブ起動に失敗しました。GCP コンソールで Cloud Run Jobs のログを確認してください。」

---

## 3. 朝9時ジョブ未実行時の自動実行＋通知機能（ウォッチドッグ）

### 目的
朝9時のスケジュール実行が何らかの理由で失敗・未実行だった場合に、自動でリトライし、結果を Discord に通知する。

### 方式
既存の Cloud Run Job インフラを活用し、新しいジョブタイプ `watchdog` を追加する。Cloud Scheduler で朝9:10（9時のジョブ完了を待つ余裕をもって）に実行。

### 変更ファイル
- `packages/job/src/index.ts` — watchdog ケース追加
- `packages/job/src/jobs/watchdog.ts` — 新規作成
- `packages/job/src/lib/discord.ts` — 変更なし（既存関数を再利用）
- `cloudbuild.yaml` — haraka-watchdog ジョブ定義追加

### 処理フロー
```
watchdog 起動（10:00 JST）
  │
  ├─ 1. Supabase から本日の scheduler トリガーの run を検索
  │     条件: triggered_by='scheduler' AND started_at >= 本日00:00 JST
  │
  ├─ 2. 結果に応じて分岐:
  │
  │   ├─ A. completed の run がある → 正常。何もしない（ログのみ）
  │   │
  │   ├─ B. failed の run がある → Discord に「朝ジョブ失敗」警告通知
  │   │     ├─ Cloud Run Job `haraka-sync` を自動リトライ実行
  │   │     ├─ 完了後 `haraka-generate` も自動実行
  │   │     └─ 結果を Discord に通知
  │   │
  │   └─ C. run が存在しない → Discord に「朝ジョブ未実行」警告通知
  │         ├─ Cloud Run Job `haraka-sync` を自動実行
  │         ├─ 完了後 `haraka-generate` も自動実行
  │         └─ 結果を Discord に通知
  │
  └─ process.exit(0)
```

### 実装詳細

#### `packages/job/src/jobs/watchdog.ts`
```typescript
export async function runWatchdog() {
  const supabase = await createSupabaseClientFromSecrets();

  // 本日 00:00 JST を計算
  const now = new Date();
  const jstOffset = 9 * 60 * 60 * 1000;
  const todayJST = new Date(now.getTime() + jstOffset);
  todayJST.setUTCHours(0, 0, 0, 0);
  const todayStart = new Date(todayJST.getTime() - jstOffset);

  // 本日の scheduler run を検索
  const { data: runs } = await supabase
    .from('run')
    .select('*')
    .eq('triggered_by', 'scheduler')
    .gte('started_at', todayStart.toISOString())
    .order('started_at', { ascending: false });

  const completedRun = runs?.find(r => r.status === 'completed' && r.generate_done_at);
  const failedRun = runs?.find(r => r.status === 'failed');

  if (completedRun) {
    // A: 正常完了 → ログのみ
    console.log('[watchdog] 朝ジョブ正常完了確認済み');
    return;
  }

  // B or C: 失敗 or 未実行 → 通知 + リトライ
  const reason = failedRun
    ? `朝9時ジョブが失敗しています: ${failedRun.error_message?.substring(0, 200)}`
    : '朝9時ジョブが実行されていません';

  await sendDiscordNotification({
    title: '⚠️ 朝ジョブ未完了検知',
    description: `${reason}\n自動リトライを実行します。`,
    color: COLOR.WARNING,
  });

  // Sync → Generate を順番に実行
  try {
    await runSync();
    await runGenerate();
    await sendDiscordNotification({
      title: '🟢 ウォッチドッグ: リトライ成功',
      description: 'Sync → Generate の自動リトライが正常に完了しました。',
      color: COLOR.SUCCESS,
    });
  } catch (err) {
    // 各ジョブ内で既に Discord 通知済みなので、ここでは追加の警告のみ
    await sendDiscordNotification({
      title: '🔴 ウォッチドッグ: リトライ失敗',
      description: `自動リトライも失敗しました。手動対応が必要です。\n${err instanceof Error ? err.message.substring(0, 500) : String(err)}`,
      color: COLOR.ERROR,
    });
    throw err;
  }
}
```

#### `packages/job/src/index.ts` への追加
```typescript
case 'watchdog':
  await runWatchdog();
  break;
```

#### `cloudbuild.yaml` への追加
```yaml
- name: 'gcr.io/google.com/cloudsdktool/cloud-sdk'
  entrypoint: 'gcloud'
  args:
    - 'run'
    - 'jobs'
    - 'update'
    - 'haraka-watchdog'
    - '--image=asia-northeast1-docker.pkg.dev/$PROJECT_ID/haraka/haraka-job'
    - '--region=asia-northeast1'
    - '--task-timeout=5400'
    - '--memory=2Gi'
    - '--set-env-vars=JOB_NAME=watchdog,TRIGGER=watchdog'
```

#### Cloud Scheduler 設定（デプロイ後に手動実行）
```bash
gcloud scheduler jobs create http haraka-watchdog \
  --schedule="10 9 * * *" \
  --time-zone="Asia/Tokyo" \
  --uri="https://asia-northeast1-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/spectre-tomstocks-20260227/jobs/haraka-watchdog:run" \
  --http-method=POST \
  --oauth-service-account-email=569936489397-compute@developer.gserviceaccount.com \
  --location=asia-northeast1
```

### タイムアウト設計
- Sync: 最大30分 + Generate: 最大60分 = 合計90分（5400秒）をウォッチドッグのタイムアウトに設定

---

## デプロイ手順

1. コード変更をコミット＆プッシュ
2. `gcloud builds submit` でビルド＆デプロイ
3. Cloud Run Job `haraka-watchdog` を新規作成（初回のみ）:
   ```bash
   gcloud run jobs create haraka-watchdog \
     --image=asia-northeast1-docker.pkg.dev/spectre-tomstocks-20260227/haraka/haraka-job \
     --region=asia-northeast1 \
     --task-timeout=5400 \
     --memory=2Gi \
     --set-env-vars=JOB_NAME=watchdog,TRIGGER=watchdog
   ```
4. Cloud Scheduler `haraka-watchdog` を新規作成
5. GCP Monitoring アラートポリシーを設定（項目2）
