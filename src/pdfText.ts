// src/pdfText.ts
// Extract embedded text from a PDF (no OCR).
// Uses pdfjs "legacy" build for better compatibility in Vite/StackBlitz/WebContainer.

import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import workerSrc from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";

(pdfjs as any).GlobalWorkerOptions.workerSrc = workerSrc;

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (err) => {
        clearTimeout(t);
        reject(err);
      }
    );
  });
}

export type PdfTextResult = {
  text: string;
  numPages: number;
  pagesSampled: number;
  chars: number;
  textItems: number;
};

export async function extractPdfText(buffer: ArrayBuffer): Promise<PdfTextResult> {
  const loadingTask = (pdfjs as any).getDocument({ data: buffer });
  const pdf = (await withTimeout(loadingTask.promise, 30000, "PDF load")) as any;

  const numPages = (pdf.numPages as number) || 0;
  const pagesSampled = Math.min(numPages, 6);

  let text = "";
  let textItems = 0;

  for (let i = 1; i <= pagesSampled; i++) {
    const page = (await withTimeout(pdf.getPage(i), 15000, `PDF getPage(${i})`)) as any;
    const content = (await withTimeout(page.getTextContent(), 15000, `PDF getTextContent(${i})`)) as any;
    const items = (content.items || []) as any[];
    textItems += items.length;

    const strings = items
      .map((item) => (typeof item?.str === "string" ? item.str : ""))
      .filter(Boolean);

    text += strings.join(" ") + "\n";
    if (text.length >= 5000) break;
  }

  return { text, numPages, pagesSampled, chars: text.length, textItems };
}
