import JSZip from 'jszip';

export type DownloadableImage = {
  image_url: string;
  filename: string;
};

/**
 * Web Share API で画像を共有（スマホ向け: 写真アプリに保存可能）
 * 非対応ブラウザではZIPフォールバック
 */
export async function shareOrDownloadImages(
  images: DownloadableImage[],
  zipFilename: string,
  onProgress?: (current: number, total: number) => void,
): Promise<void> {
  // 1枚だけならシンプルに共有/ダウンロード
  if (images.length === 1) {
    const img = images[0];
    onProgress?.(0, 1);
    const res = await fetch(img.image_url);
    if (!res.ok) throw new Error('Failed to fetch image');
    const blob = await res.blob();
    onProgress?.(1, 1);

    const file = new File([blob], img.filename, { type: blob.type || 'image/png' });
    if (canShareFiles([file])) {
      await navigator.share({ files: [file] });
      return;
    }
    triggerDownload(blob, img.filename);
    return;
  }

  // 複数枚: まず全画像をfetch
  const files: File[] = [];
  for (let i = 0; i < images.length; i++) {
    onProgress?.(i, images.length);
    try {
      const res = await fetch(images[i].image_url);
      if (!res.ok) continue;
      const blob = await res.blob();
      files.push(new File([blob], images[i].filename, { type: blob.type || 'image/png' }));
    } catch {
      // skip failed images
    }
  }
  onProgress?.(images.length, images.length);

  if (files.length === 0) return;

  // Web Share API で共有を試みる
  if (canShareFiles(files)) {
    try {
      await navigator.share({ files });
      return;
    } catch (e) {
      // AbortError = ユーザーがキャンセル → それでOK
      if (e instanceof Error && e.name === 'AbortError') return;
      // その他のエラー → ZIPフォールバック
    }
  }

  // フォールバック: ZIP
  await zipAndDownload(files, zipFilename);
}

/**
 * 複数画像をZIPファイルとしてダウンロード（従来互換）
 */
export async function downloadImagesAsZip(
  images: DownloadableImage[],
  zipFilename: string,
  onProgress?: (current: number, total: number) => void,
): Promise<void> {
  const zip = new JSZip();

  for (let i = 0; i < images.length; i++) {
    onProgress?.(i, images.length);
    try {
      const res = await fetch(images[i].image_url);
      if (!res.ok) continue;
      const blob = await res.blob();
      zip.file(images[i].filename, blob);
    } catch {
      // skip failed images
    }
  }

  onProgress?.(images.length, images.length);

  const content = await zip.generateAsync({ type: 'blob' });
  triggerDownload(content, zipFilename);
}

/**
 * 単一画像をダウンロード
 */
export async function downloadSingleImage(url: string, filename: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok) throw new Error('Failed to fetch image');
  const blob = await res.blob();
  triggerDownload(blob, filename);
}

/** Web Share API でファイル共有が可能か判定 */
function canShareFiles(files: File[]): boolean {
  return typeof navigator !== 'undefined'
    && typeof navigator.share === 'function'
    && typeof navigator.canShare === 'function'
    && navigator.canShare({ files });
}

/** File[] からZIPを生成してダウンロード */
async function zipAndDownload(files: File[], zipFilename: string): Promise<void> {
  const zip = new JSZip();
  for (const file of files) {
    zip.file(file.name, file);
  }
  const content = await zip.generateAsync({ type: 'blob' });
  triggerDownload(content, zipFilename);
}

function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
