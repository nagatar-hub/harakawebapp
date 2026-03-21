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

### Step 7: Syncジョブのエラー通知
**ファイル:** `packages/job/src/jobs/sync.ts`

- `invalid_grant`（`OAuthInvalidGrantError`）をcatchで特別処理
  - Run レコードの`error_message`に「再認証が必要」と明記
  - ステータスを `auth_failed` に設定（UIで目立つように）

---

## 対象外（今回は実施しない）

- Supabase上のX認証トークン暗号化（別の問題）
- トークンキャッシング（毎回refresh tokenからaccess token取得は冗長だが、実害は少ない）
- Secret Manager upsert時のレースコンディション（発生頻度が極めて低い）

---

## 変更ファイル一覧

| ファイル | 操作 |
|---------|------|
| `packages/job/src/lib/fetch-with-retry.ts` | **新規** |
| `packages/job/src/lib/google-sheets.ts` | 修正 |
| `packages/job/src/lib/auth.ts` | 修正 |
| `packages/job/src/lib/secret-manager.ts` | 修正 |
| `packages/job/src/lib/google-drive.ts` | 修正 |
| `packages/job/src/jobs/sync.ts` | 修正 |
| `packages/api/src/lib/haraka-db-sheet.ts` | 修正 |
| `packages/api/src/lib/fetch-with-retry.ts` | **新規**（API側用） |
