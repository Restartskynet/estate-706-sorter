// src/types/pdfjs-legacy.d.ts
declare module "pdfjs-dist/legacy/build/pdf.mjs" {
  export const GlobalWorkerOptions: any;
  export function getDocument(...args: any[]): any;
  const _default: any;
  export default _default;
}

declare module "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url" {
  const src: string;
  export default src;
}
