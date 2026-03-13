import JSZip from 'jszip';

export type DownloadableImage = {
  image_url: string;
  filename: string;
};

/**
 * 複数画像をZIPファイルとしてダウンロード
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
