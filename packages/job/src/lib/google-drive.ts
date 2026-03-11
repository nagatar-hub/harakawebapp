/**
 * Google Drive ダウンロードヘルパー
 *
 * テンプレート画像、カード裏面画像、レアリティアイコン等を
 * Google Drive から Buffer としてダウンロードする。
 */

const DRIVE_API_BASE = 'https://www.googleapis.com/drive/v3/files';

/**
 * Google Drive ファイルを Buffer としてダウンロード
 */
export async function downloadDriveFile(
  accessToken: string,
  fileId: string,
): Promise<Buffer> {
  const url = `${DRIVE_API_BASE}/${fileId}?alt=media`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Drive download failed (${fileId}): ${res.status} ${res.statusText} — ${body}`);
  }

  const arrayBuffer = await res.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

/**
 * URL（Drive ID or HTTP URL）から画像をダウンロード
 *
 * - Google Drive のファイル ID なら Drive API 経由
 * - https:// URL ならそのまま fetch
 * - 失敗時は null を返す
 */
export async function downloadImage(
  accessToken: string,
  urlOrDriveId: string,
): Promise<Buffer | null> {
  try {
    if (urlOrDriveId.startsWith('http://') || urlOrDriveId.startsWith('https://')) {
      // 通常の HTTP(S) URL
      const res = await fetch(urlOrDriveId, {
        headers: { 'User-Agent': 'Haraka-Job/1.0' },
      });
      if (!res.ok) return null;
      const arrayBuffer = await res.arrayBuffer();
      return Buffer.from(arrayBuffer);
    } else {
      // Google Drive ファイル ID
      return await downloadDriveFile(accessToken, urlOrDriveId);
    }
  } catch {
    return null;
  }
}

/**
 * 複数の画像を並列ダウンロード（同時接続数制限付き）
 */
export async function downloadImagesWithConcurrency(
  accessToken: string,
  urls: (string | null)[],
  concurrency: number = 5,
): Promise<(Buffer | null)[]> {
  const results: (Buffer | null)[] = new Array(urls.length).fill(null);
  let index = 0;

  async function worker() {
    while (index < urls.length) {
      const currentIndex = index++;
      const url = urls[currentIndex];
      if (!url) continue;
      results[currentIndex] = await downloadImage(accessToken, url);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, urls.length) }, () => worker());
  await Promise.all(workers);

  return results;
}
