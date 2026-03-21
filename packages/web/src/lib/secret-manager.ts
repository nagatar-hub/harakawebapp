import { SecretManagerServiceClient } from '@google-cloud/secret-manager';

const client = new SecretManagerServiceClient();
const PROJECT_ID = process.env.GCP_PROJECT_ID || 'spectre-tomstocks-20260227';

/**
 * Secret Manager のシークレットに新しいバージョンを追加する。
 * 既存のシークレットが存在する前提。
 */
export async function upsertSecret(secretName: string, value: string): Promise<void> {
  const parent = `projects/${PROJECT_ID}/secrets/${secretName}`;

  await client.addSecretVersion({
    parent,
    payload: {
      data: Buffer.from(value, 'utf8'),
    },
  });
}
