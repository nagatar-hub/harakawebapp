import { SecretManagerServiceClient } from '@google-cloud/secret-manager';

const client = new SecretManagerServiceClient();
const PROJECT_ID = process.env.GCP_PROJECT_ID || 'spectre-tomstocks-20260227';

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;

/**
 * Secret Manager からシークレットを取得する（リトライ＋検証付き）。
 *
 * 一時的な障害（ネットワーク、gRPC タイムアウト等）に対して
 * 指数バックオフでリトライする。取得した値が空の場合はエラーをスローする。
 */
export async function getSecret(secretName: string): Promise<string> {
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const [version] = await client.accessSecretVersion({
        name: `projects/${PROJECT_ID}/secrets/${secretName}/versions/latest`,
      });
      const payload = version.payload?.data;
      if (!payload) throw new Error(`Secret ${secretName} has no payload`);

      const value = typeof payload === 'string' ? payload : Buffer.from(payload).toString('utf8');

      // 空文字チェック
      if (!value.trim()) {
        throw new Error(`Secret ${secretName} is empty. 再設定してください。`);
      }

      return value;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));

      // NOT_FOUND / PERMISSION_DENIED はリトライしない
      const msg = lastError.message;
      if (msg.includes('NOT_FOUND') || msg.includes('PERMISSION_DENIED') || msg.includes('is empty')) {
        throw lastError;
      }

      if (attempt < MAX_RETRIES) {
        const delay = BASE_DELAY_MS * 2 ** attempt;
        console.warn(
          `[secret-manager] ${secretName} 取得失敗 (attempt ${attempt + 1}/${MAX_RETRIES + 1}), ${delay}ms 後にリトライ: ${msg}`,
        );
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }

  throw lastError ?? new Error(`Secret ${secretName} の取得に失敗しました`);
}
