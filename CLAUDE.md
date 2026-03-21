# CLAUDE.md

## コミュニケーションルール

- ユーザーには必ず丁寧語（です・ます調）で話すこと。ため口は絶対に使わない。

## 認証構成（重要）

このプロジェクトでは **2つの異なるGoogleアカウント** を使い分けている。OAuth Client ID/Secret は共通だが、リフレッシュトークンが別々。

### 1. Haraka DB アカウント（メイン）
- **Googleアカウント**: `nagata.r@tomstocks.net`（GCP プロジェクトオーナー）
- **用途**: Haraka DB スプレッドシート（DB タブ、RarityIcons、SpectreMapping 等）へのアクセス、Google Drive からの画像DL
- **Secret Manager**: `haraka-oauth-refresh-token`, `haraka-oauth-client-id`, `haraka-oauth-client-secret`
- **環境変数**: `GOOGLE_REFRESH_TOKEN`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`
- **使用箇所**: `getAccessToken()` — sync.ts（DB照合）、generate.ts（テンプレDL、画像生成）、API（タグ書き戻し）

### 2. KECAK アカウント（別アカウント）
- **Googleアカウント**: `oripark.raox.akb@gmail.com`
- **用途**: KECAK スプレッドシート（在庫データ3シート）へのアクセス。**Haraka DB とは別の Google アカウントが所有するシート**
- **Secret Manager**: `haraka-oauth-kecak-refresh-token`（Client ID/Secret は共通）
- **環境変数**: `KECAK_GOOGLE_REFRESH_TOKEN`
- **使用箇所**: `getKecakAccessToken()` — sync.ts のKECAKインポートのみ
- **フォールバック**: 未設定の場合はメインアカウントの認証情報で代用（ただしKECAKシートの権限がないと失敗する）
- **備考**: Haraka DB スプレッドシートにはどちらのアカウントからもアクセス可能

### OAuth 再認証
Web UI の OAuth コールバック（`/api/auth/google/callback`）で `state` パラメータにより保存先を分岐：
- `state !== 'kecak'` → Haraka DB アカウントのトークンを更新
- `state === 'kecak'` → KECAK アカウントのトークンを更新
