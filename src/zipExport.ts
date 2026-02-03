import JSZip from 'jszip';

export interface ZipFileInput {
  path: string;
  file: File | Blob | string;
}

export async function buildZip(files: ZipFileInput[]): Promise<Blob> {
  const zip = new JSZip();

  for (const entry of files) {
    zip.file(entry.path, entry.file);
  }

  return zip.generateAsync({ type: 'blob' });
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}
