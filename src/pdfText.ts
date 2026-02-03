import { GlobalWorkerOptions, getDocument } from 'pdfjs-dist';
import workerSrc from 'pdfjs-dist/build/pdf.worker.min?url';

GlobalWorkerOptions.workerSrc = workerSrc;

export const MAX_PAGES_TEXT = 6;
export const STOP_AFTER_CHARS = 5000;

export async function extractPdfText(buffer: ArrayBuffer): Promise<string> {
  const loadingTask = getDocument({ data: buffer });
  const pdf = await loadingTask.promise;
  const pageCount = Math.min(pdf.numPages, MAX_PAGES_TEXT);
  let text = '';

  for (let pageNum = 1; pageNum <= pageCount; pageNum += 1) {
    const page = await pdf.getPage(pageNum);
    const content = await page.getTextContent();
    const pageText = content.items
      .map((item: { str?: string }) => item.str ?? '')
      .join(' ');
    text += ` ${pageText}`;
    if (text.length >= STOP_AFTER_CHARS) {
      break;
    }
  }

  return text.trim();
}
