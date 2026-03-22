# GCP/Google Sheets 障害耐性強化プラン

## 発見された問題点

### 致命的（売上に直結）

| # | 問題 | 箇所 | 影響 |
|---|------|------|------|
| 1 | **全fetchにリトライなし** | google-sheets.ts, google-drive.ts, haraka-db-sheet.ts, secret-manager.ts | 一時的なネットワーク障害・Google側503で即死 |
| 2 | **全fetchにタイムアウトなし** | 同上 | Google API無応答時にCloud Runジョブがハングし、タイムアウトまでリソース占有 |
| 3 | **`invalid_grant`の検出はあるが通知がない** | google-sheets.ts:98-102 | トークン失効に気づかず、データが古いまま売上影響 |
| 4 | **API側に独自の`getAccessToken()`が存在** | haraka-db-sheet.ts:21-50 | job側と完全に別実装。リトライもタイムアウトもエラーハンドリングも一切なし。Secret Managerも使わずenv変数直読み |
| 5 | **Secret Manager読み込み失敗で全滅** | auth.ts:35-39 | `Promise.all`で3つ同時取得、1つ失敗で3つとも失敗。リトライなし |
| 6 | **トークン値の検証なし** | auth.ts, google-sheets.ts | 空文字やnullのrefresh tokenでもそのままAPI呼び出しして`invalid_grant`に |

### 中程度

| # | 問題 | 箇所 | 影響 |
|---|------|------|------|
| 7 | **Google Sheets API 429/503への対応なし** | google-sheets.ts:147-151 | レートリミットに引っかかったら即座にエラー終了 |
| 8 | **Google Drive downloadにリトライなし** | google-drive.ts:18-20 | テンプレート画像取得失敗でページ生成失敗 |
| 9 | **Sync全体のエラーハンドリングが粗い** | sync.ts:389-397 | どのステップで失敗したか詳細な情報なし |

---

## 実装プラン

### Step 1: リトライ・タイムアウトユーティリティ作成
**ファイル:** `packages/job/src/lib/fetch-with-retry.ts`（新規）

- `fetchWithRetry(url, options, retryConfig)` 関数を作成
  - 指数バックオフ付きリトライ（デフォルト3回、1s→2s→4s）
  - `AbortController`によるタイムアウト（デフォルト30秒）
  - リトライ対象: ネットワークエラー、HTTP 429, 500, 502, 503, 504
  - `invalid_grant`等の認証エラーはリトライしない（無駄なので）
  - 全リトライのログ出力

### Step 2: google-sheets.ts の強化
**ファイル:** `packages/job/src/lib/google-sheets.ts`

- `refreshAccessToken()`: `fetch` → `fetchWithRetry` に置換
  - `invalid_grant` 検出時に専用エラークラス `OAuthInvalidGrantError` をスロー
- `fetchSheetValues()`: `fetch` → `fetchWithRetry` に置換
  - HTTP 401時に「access tokenの再取得が必要」というメッセージ付きエラー
- `appendSheetValues()`: `fetch` → `fetchWithRetry` に置換

### Step 3: haraka-db-sheet.ts の修正（API側）
**ファイル:** `packages/api/src/lib/haraka-db-sheet.ts`

- 独自の `getAccessToken()` を削除し、共通の `refreshAccessToken()` を使用
  - ※API側はSecret Managerを使えないため、env変数読みは維持するが、`refreshAccessToken`関数自体は共通化
- 全fetch呼び出しにリトライ・タイムアウトを追加

### Step 4: Secret Manager読み込みの強化
**ファイル:** `packages/job/src/lib/secret-manager.ts`

- `getSecret()` にリトライを追加（Secret Manager APIの一時障害対策）
- 取得した値の検証（空文字・nullチェック）

### Step 5: auth.ts のトークン検証追加
**ファイル:** `packages/job/src/lib/auth.ts`

- `getCredentials()` / `getKecakCredentials()` で取得したrefresh tokenが空でないか検証
- 空の場合は明確なエラーメッセージ（「再認証が必要です」）

### Step 6: google-drive.ts の強化
**ファイル:** `packages/job/src/lib/google-drive.ts`

- `downloadDriveFile()`: `fetch` → `fetchWithRetry` に置換
- `downloadImage()`: HTTP画像取得にもリトライ追加

### Step 7: Discord Webhook 通知
**ファイル:** `packages/job/src/lib/discord.ts`（新規）

Discord Webhookを使い、ジョブ完了・失敗時にプッシュ通知を送信する。
UIを見ていなくても異常にすぐ気づける仕組み。

#### 設計

```typescript
// packages/job/src/lib/discord.ts
export async function sendDiscordNotification(params: {
  title: string;
  description: string;
  color: number;          // 0x00ff00=成功, 0xff0000=失敗, 0xffaa00=警告
  fields?: { name: string; value: string; inline?: boolean }[];
}): Promise<void>
```

- **環境変数:** `DISCORD_WEBHOOK_URL`（未設定時はスキップ、ログ出力のみ）
- **Secret Manager対応:** Cloud Run Jobでは `discord-webhook-url` シークレットからも取得
- **タイムアウト:** 10秒（Discordが落ちていてもジョブは続行）
- **失敗時:** `console.warn` のみ。通知失敗でジョブを落とさない（fire-and-forget）

#### 通知タイミング

| イベント | 色 | 通知内容 |
|---------|-----|---------|
| **Sync 完了** | 🟢 緑 | imported/prepared/pages 件数、所要時間 |
| **Sync 失敗** | 🔴 赤 | エラーメッセージ、失敗ステップ |
| **Generate 完了** | 🟢 緑 | 生成ページ数、所要時間 |
| **Generate 失敗** | 🔴 赤 | エラーメッセージ |
| **OAuth invalid_grant** | 🔴 赤 | 「再認証が必要です」+ どのアカウントか |
| **画像NG多発** | 🟡 黄 | `total_image_ng > 10` の場合に警告 |
| **朝9時テストラン結果** | 下記参照 | 下記参照 |

#### Embed形式例（失敗時）

```json
{
  "embeds": [{
    "title": "🔴 Sync ジョブ失敗",
    "description": "OAuth トークンが失効しています。再認証してください。",
    "color": 16711680,
    "fields": [
      { "name": "ジョブ", "value": "sync", "inline": true },
      { "name": "トリガー", "value": "scheduler", "inline": true },
      { "name": "エラー", "value": "invalid_grant: Token has been revoked" }
    ],
    "timestamp": "2026-03-21T09:00:15Z"
  }]
}
```

#### 実装箇所の変更

- `packages/job/src/jobs/sync.ts`: 完了/失敗の `catch`/`finally` に `sendDiscordNotification` を追加
- `packages/job/src/jobs/generate.ts`: 同上
- `packages/job/src/index.ts`: トップレベル `catch` にもフォールバック通知（sync/generate内で通知送信前にクラッシュした場合の保険）

### Step 8: 朝9時テストラン（スケジュール実行）

毎朝9時（JST）にSyncジョブを自動実行し、結果をDiscordに通知する。

#### アーキテクチャ選択肢の比較

| 方式 | メリット | デメリット |
|------|---------|-----------|
| **A. Cloud Scheduler → API エンドポイント** | 追加インフラ最小、既存の `POST /api/jobs/sync` を叩くだけ | API Cloud Runインスタンスが常時起動前提。コールドスタートだとタイムアウトの恐れ |
| **B. Cloud Scheduler → Cloud Run Jobs** | ジョブ専用コンテナで実行、リソース分離が完璧 | Cloud Run Jobsの別途デプロイが必要（現在はfork()方式）|
| **C. API内のnode-cron** | コード完結、追加インフラ不要 | Cloud Runのインスタンスが0にスケールすると動かない。複数インスタンスで重複実行リスク |

#### 採用: **B. Cloud Scheduler → Cloud Run Jobs**

**理由:**
1. ジョブ専用コンテナでリソース分離が完璧（APIに影響ゼロ）
2. タスクタイムアウトを最大24時間まで設定可能（APIの300s制限に縛られない）
3. Job専用にメモリ2Gi等を割り当て可能
4. Cloud Run Jobsのネイティブリトライ機能が使える
5. 独立したログストリーム（APIのログに混在しない）
6. Cloud Schedulerは無料枠で3ジョブまで使える
7. `packages/job/Dockerfile` は既に完成済み。`cloudbuild.yaml` にJob用ステップを追加するだけ

#### 実装内容

**1. cloudbuild.yaml にJob用ビルド・デプロイを追加**

API用ビルドの後に、Jobイメージのビルド・プッシュ・Cloud Run Jobs更新ステップを追加。
`haraka-sync` と `haraka-generate` の2つのCloud Run Jobsを更新する。

**2. Cloud Run Jobs の初回作成（手動/gcloud CLI）**

```bash
# Sync ジョブ作成
gcloud run jobs create haraka-sync \
  --image=asia-northeast1-docker.pkg.dev/$PROJECT_ID/haraka/haraka-job \
  --region=asia-northeast1 \
  --task-timeout=1800 \
  --memory=2Gi \
  --set-env-vars=JOB_NAME=sync,TRIGGER=scheduler \
  --set-secrets=SUPABASE_URL=supabase-url:latest,SUPABASE_SERVICE_ROLE_KEY=supabase-service-role-key:latest,DISCORD_WEBHOOK_URL=discord-webhook-url:latest

# Generate ジョブ作成
gcloud run jobs create haraka-generate \
  --image=asia-northeast1-docker.pkg.dev/$PROJECT_ID/haraka/haraka-job \
  --region=asia-northeast1 \
  --task-timeout=3600 \
  --memory=2Gi \
  --set-env-vars=JOB_NAME=generate,TRIGGER=scheduler \
  --set-secrets=SUPABASE_URL=supabase-url:latest,SUPABASE_SERVICE_ROLE_KEY=supabase-service-role-key:latest,DISCORD_WEBHOOK_URL=discord-webhook-url:latest
```

**3. Cloud Scheduler 設定（手動/gcloud CLI）**

```bash
# 朝9時に Sync ジョブを実行
gcloud scheduler jobs create http haraka-morning-sync \
  --schedule="0 9 * * *" \
  --time-zone="Asia/Tokyo" \
  --uri="https://asia-northeast1-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/$PROJECT_ID/jobs/haraka-sync:run" \
  --http-method=POST \
  --oauth-service-account-email=$PROJECT_NUMBER-compute@developer.gserviceaccount.com \
  --location=asia-northeast1
```

**4. テストラン結果のDiscord通知**

Sync完了時にDiscordに結果サマリーを通知。`TRIGGER=scheduler` の場合は「朝9時テストラン完了」と表記。

```
🟢 朝9時テストラン完了
━━━━━━━━━━━━━━━━━━━
インポート: 1,234件
カード準備: 890件
画像NG: 3件
タグなし: 12件
ページ数: 45ページ
所要時間: 2分34秒
```

**5. 環境変数の追加**

| 変数名 | 用途 | 設定場所 |
|--------|------|---------|
| `DISCORD_WEBHOOK_URL` | Discord通知先 | .env / Secret Manager |

---

## 変更ファイル一覧

| ファイル | 操作 | ステップ |
|---------|------|---------|
| `packages/job/src/lib/fetch-with-retry.ts` | **新規** | Step 1 |
| `packages/job/src/lib/google-sheets.ts` | 修正 | Step 2 |
| `packages/api/src/lib/haraka-db-sheet.ts` | 修正 | Step 3 |
| `packages/job/src/lib/secret-manager.ts` | 修正 | Step 4 |
| `packages/job/src/lib/auth.ts` | 修正 | Step 5 |
| `packages/job/src/lib/google-drive.ts` | 修正 | Step 6 |
| `packages/job/src/lib/discord.ts` | **新規** | Step 7 |
| `packages/job/src/jobs/sync.ts` | 修正 | Step 7 |
| `packages/job/src/jobs/generate.ts` | 修正 | Step 7 |
| `packages/job/src/index.ts` | 修正 | Step 7 |
| `packages/api/src/routes/runs.ts` | 修正 | Step 8 |
| `packages/api/src/lib/fetch-with-retry.ts` | **新規** | Step 3 |
| `.env.example` | 修正 | Step 7-8 |

---

## 対象外（今回は実施しない）

- Supabase上のX認証トークン暗号化（別の問題）
- トークンキャッシング（毎回refresh tokenからaccess token取得は冗長だが、実害は少ない）
- Secret Manager upsert時のレースコンディション（発生頻度が極めて低い）
- node-cronベースのインプロセススケジューラ（Cloud Runとの相性が悪い）
