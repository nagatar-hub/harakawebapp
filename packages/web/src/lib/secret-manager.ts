import { SecretManagerServiceClient } from '@google-cloud/secret-manager';

const client = new SecretManagerServiceClient();
const PROJECT_ID = process.env.GCP_PROJECT_ID || 'spectre-tomstocks-20260227';

/**
 * Secret Manager のシークレットに新しいバージョンを追加する。
 * シークレットが存在しない場合は自動作成する。
 */
export async function upsertSecret(secretName: string, value: string): Promise<void> {
  const parent = `projects/${PROJECT_ID}/secrets/${secretName}`;

  try {
    await client.addSecretVersion({
      parent,
      payload: {
        data: Buffer.from(value, 'utf8'),
      },
    });
  } catch (err: unknown) {
    const code = (err as { code?: number }).code;
    // 5 = NOT_FOUND — シークレットが存在しない場合は作成してリトライ
    if (code === 5) {
      await client.createSecret({
        parent: `projects/${PROJECT_ID}`,
        secretId: secretName,
        secret: { replication: { automatic: {} } },
      });
      await client.addSecretVersion({
        parent,
        payload: {
          data: Buffer.from(value, 'utf8'),
        },
      });
    } else {
      throw err;
    }
  }
}
