/**
 * GET /api/auth/google/callback
 *
 * Google OAuth コールバックエンドポイント。
 * Google から受け取った認可コードを使ってトークンを取得し、
 * refresh_token を Secret Manager に保存する。
 *
 * クエリパラメータ:
 *   code  — Google が発行した認可コード
 *   error — 認可が拒否された場合のエラーコード（例: access_denied）
 */

import { NextRequest, NextResponse } from 'next/server';
import {
  exchangeCodeForTokens,
  extractRefreshToken,
  validateEnvVars,
} from '@/lib/google-oauth';
import { upsertSecret } from '@/lib/secret-manager';

export async function GET(request: NextRequest): Promise<NextResponse> {
  const { searchParams } = request.nextUrl;

  // --- ユーザーが認可を拒否した場合 ---
  const oauthError = searchParams.get('error');
  if (oauthError) {
    return NextResponse.json(
      { error: 'OAuth authorization denied', detail: oauthError },
      { status: 400 }
    );
  }

  // --- 認可コードの取得 ---
  const code = searchParams.get('code');
  if (!code) {
    return NextResponse.json(
      { error: 'Missing authorization code' },
      { status: 400 }
    );
  }

  // --- 環境変数の検証 ---
  const envResult = validateEnvVars(request.headers);
  if (!envResult.ok) {
    return NextResponse.json(
      { error: 'Configuration error', detail: envResult.error },
      { status: 500 }
    );
  }

  const { clientId, clientSecret, baseUrl } = envResult.value;
  const redirectUri = `${baseUrl}/api/auth/google/callback`;

  // --- 認可コードをトークンと交換 ---
  const tokenResult = await exchangeCodeForTokens({
    code,
    clientId,
    clientSecret,
    redirectUri,
  });

  if (!tokenResult.ok) {
    return NextResponse.json(
      { error: 'Token exchange failed', detail: tokenResult.error },
      { status: 502 }
    );
  }

  const tokens = tokenResult.value;
  const refreshToken = extractRefreshToken(tokens);

  if (!refreshToken) {
    return NextResponse.json({
      status: 'warning',
      message: 'トークン取得成功。ただし refresh_token が含まれていません。prompt=consent で再認可してください。',
    });
  }

  // --- Secret Manager に refresh_token を保存 ---
  try {
    await upsertSecret('haraka-oauth-refresh-token', refreshToken);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      {
        error: 'Secret Manager への保存に失敗しました',
        detail: message,
        refresh_token: refreshToken,
      },
      { status: 500 }
    );
  }

  return NextResponse.json({
    status: 'ok',
    message: 'Google OAuth refresh token を Secret Manager に保存しました。',
    scope: tokens.scope,
  });
}
