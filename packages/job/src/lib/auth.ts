/**
 * OAuth 認証ヘルパー
 *
 * sync / generate 両ジョブで共通利用
 *
 * Haraka DB シートと KECAK シートは異なる Google アカウントに
 * 紐づいているため、KECAK 用には別の refresh token を使用する。
 */

import { refreshAccessToken } from './google-sheets.js';

export interface OAuthCredentials {
  refreshToken: string;
  clientId: string;
  clientSecret: string;
}

/**
 * OAuth 認証情報を取得する（Haraka DB シート用）。
 * ローカル: .env から読み込み
 * Cloud Run: Secret Manager から読み込み
 */
export async function getCredentials(): Promise<OAuthCredentials> {
  // ローカル開発: .env に値がある場合はそれを使用
  if (process.env.GOOGLE_REFRESH_TOKEN && process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
    return validateCredentials({
      refreshToken: process.env.GOOGLE_REFRESH_TOKEN,
      clientId: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    });
  }

  // Cloud Run: Secret Manager から取得
  const { getSecret } = await import('./secret-manager.js');
  const [refreshToken, clientId, clientSecret] = await Promise.all([
    getSecret('haraka-oauth-refresh-token'),
    getSecret('haraka-oauth-client-id'),
    getSecret('haraka-oauth-client-secret'),
  ]);
  return validateCredentials({ refreshToken, clientId, clientSecret });
}

/**
 * KECAK シート用 OAuth 認証情報を取得する。
 * KECAK シートにアクセス権限のある Google アカウントの refresh token を使用。
 * 未設定の場合はデフォルトの認証情報にフォールバックする。
 */
export async function getKecakCredentials(): Promise<OAuthCredentials> {
  // ローカル開発: KECAK 専用の refresh token があればそれを使用
  if (process.env.KECAK_GOOGLE_REFRESH_TOKEN) {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
      throw new Error('GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET が未設定です');
    }
    return validateCredentials({
      refreshToken: process.env.KECAK_GOOGLE_REFRESH_TOKEN,
      clientId,
      clientSecret,
    });
  }

  // Cloud Run: Secret Manager から KECAK 用 refresh token を取得
  const { getSecret } = await import('./secret-manager.js');

  let kecakRefreshToken: string;
  try {
    kecakRefreshToken = await getSecret('haraka-oauth-kecak-refresh-token');
  } catch {
    // KECAK 用シークレットが未登録の場合はデフォルトにフォールバック
    console.warn('[auth] haraka-oauth-kecak-refresh-token が未設定のため、デフォルト認証情報を使用します');
    return getCredentials();
  }

  const [clientId, clientSecret] = await Promise.all([
    getSecret('haraka-oauth-client-id'),
    getSecret('haraka-oauth-client-secret'),
  ]);
  return validateCredentials({ refreshToken: kecakRefreshToken, clientId, clientSecret });
}

/**
 * 認証情報を取得し、access token を返す（Haraka DB シート用）
 */
export async function getAccessToken(): Promise<string> {
  const creds = await getCredentials();
  return refreshAccessToken(creds);
}

/**
 * KECAK シート用 access token を返す
 */
export async function getKecakAccessToken(): Promise<string> {
  const creds = await getKecakCredentials();
  return refreshAccessToken(creds);
}

// ---------------------------------------------------------------------------
// スプレッドシート ID 取得（ローカル: env / Cloud Run: Secret Manager）
// ---------------------------------------------------------------------------

/**
 * KECAK スプレッドシート ID を取得する。
 * ローカル: KECAK_SPREADSHEET_ID 環境変数
 * Cloud Run: Secret Manager (haraka-kecak-spreadsheet-id)
 */
export async function getKecakSpreadsheetId(): Promise<string> {
  if (process.env.KECAK_SPREADSHEET_ID) {
    return process.env.KECAK_SPREADSHEET_ID;
  }
  const { getSecret } = await import('./secret-manager.js');
  return getSecret('haraka-kecak-spreadsheet-id');
}

/**
 * Haraka DB スプレッドシート ID を取得する。
 * ローカル: HARAKA_DB_SPREADSHEET_ID 環境変数
 * Cloud Run: Secret Manager (haraka-db-spreadsheet-id)
 */
export async function getHarakaDbSpreadsheetId(): Promise<string> {
  if (process.env.HARAKA_DB_SPREADSHEET_ID) {
    return process.env.HARAKA_DB_SPREADSHEET_ID;
  }
  const { getSecret } = await import('./secret-manager.js');
  return getSecret('haraka-db-spreadsheet-id');
}

/**
 * 認証情報の空チェック。空の credential でAPI呼び出ししても
 * invalid_grant になるだけなので、早期にエラーを出す。
 */
function validateCredentials(creds: OAuthCredentials): OAuthCredentials {
  if (!creds.refreshToken?.trim()) {
    throw new Error('OAuth refresh token が空です。再認証が必要です。');
  }
  if (!creds.clientId?.trim()) {
    throw new Error('OAuth client ID が空です。');
  }
  if (!creds.clientSecret?.trim()) {
    throw new Error('OAuth client secret が空です。');
  }
  return creds;
}
