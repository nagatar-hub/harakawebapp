/**
 * GET /api/auth/google
 *
 * Google OAuth 認証フローの開始エンドポイント。
 * Google の認証ページにリダイレクトする。
 *
 * クエリパラメータ:
 *   target=kecak — KECAK シート用アカウントで認証する場合に指定
 *
 * 必要な環境変数:
 *   GOOGLE_CLIENT_ID     — Google Cloud Console で発行したクライアント ID
 *   GOOGLE_CLIENT_SECRET — Google Cloud Console で発行したクライアントシークレット
 *   NEXTAUTH_URL         — このアプリのベース URL（省略時: http://localhost:3001）
 */

import { NextRequest, NextResponse } from 'next/server';
import { buildAuthorizationUrl, validateEnvVars } from '@/lib/google-oauth';

export async function GET(request: NextRequest): Promise<NextResponse> {
  const envResult = validateEnvVars(request.headers);

  if (!envResult.ok) {
    return NextResponse.json(
      { error: 'Configuration error', detail: envResult.error },
      { status: 500 }
    );
  }

  const { clientId, baseUrl } = envResult.value;

  // target=kecak の場合、callback に state パラメータで伝搬する
  const target = request.nextUrl.searchParams.get('target');
  const redirectUri = `${baseUrl}/api/auth/google/callback`;

  const authUrl = buildAuthorizationUrl({ clientId, redirectUri, state: target === 'kecak' ? 'kecak' : undefined });

  return NextResponse.redirect(authUrl);
}
