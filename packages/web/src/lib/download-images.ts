import JSZip from 'jszip';

export type DownloadableImage = {
  image_url: string;
  filename: string;
};

/** Web Share API が使えるかどうか（ダミーファイルで判定） */
function isShareSupported(): boolean {
  if (typeof navigator === 'undefined') return false;
  if (typeof navigator.share !== 'function') return false;
  if (typeof navigator.canShare !== 'function') return false;
  const dummy = new File([''], 'test.png', { type: 'image/png' });
  return navigator.canShare({ files: [dummy] });
}

/** 少数枚（≤3）かつWeb Share対応なら共有、それ以外はZIP */
export async function shareOrDownloadImages(
  images: DownloadableImage[],
  zipFilename: string,
  onProgress?: (current: number, total: number) => void,
): Promise<void> {
  const useShare = isShareSupported() && images.length <= 3;

  // 画像をfetch
  const blobs: { blob: Blob; filename: string }[] = [];
  for (let i = 0; i < images.length; i++) {
    onProgress?.(i, images.length);
    try {
      const res = await fetch(images[i].image_url);
      if (!res.ok) continue;
      const blob = await res.blob();
      blobs.push({ blob, filename: images[i].filename });
    } catch {
      // skip
    }
  }
  onProgress?.(images.length, images.length);

  if (blobs.length === 0) return;

  if (useShare) {
    const files = blobs.map(b => new File([b.blob], b.filename, { type: b.blob.type || 'image/png' }));
    try {
      await navigator.share({ files });
      return;
    } catch (e) {
      if (e instanceof Error && e.name === 'AbortError') return;
      // share失敗 → ZIPフォールバック
    }
  }

  // ZIP
  const zip = new JSZip();
  for (const b of blobs) {
    zip.file(b.filename, b.blob);
  }
  const content = await zip.generateAsync({ type: 'blob' });
  triggerDownload(content, zipFilename);
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
 * 単一画像をダウンロード/共有
 */
export async function downloadSingleImage(url: string, filename: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok) throw new Error('Failed to fetch image');
  const blob = await res.blob();

  // Web Share API 対応なら共有メニュー
  if (isShareSupported()) {
    const file = new File([blob], filename, { type: blob.type || 'image/png' });
    try {
      await navigator.share({ files: [file] });
      return;
    } catch (e) {
      if (e instanceof Error && e.name === 'AbortError') return;
    }
  }

  triggerDownload(blob, filename);
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
