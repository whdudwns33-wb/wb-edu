/**
 * 브라우저 안에서 PDF 텍스트를 뽑는다 (파일을 서버로 보내지 않음).
 * pdf.js 는 필요할 때만 불러와 첫 화면 번들 크기를 늘리지 않는다.
 * 스캔(이미지) PDF는 텍스트가 없으므로 빈 결과가 나오며, 이 경우 목차를 직접 붙여 넣어야 한다.
 */
import { textItemsToLines } from '@wb/shared';

export interface PdfTextResult {
  pageCount: number;
  lines: string[];
  /** 텍스트가 거의 없는 페이지 (스캔본 추정) */
  emptyPages: number[];
}

async function loadPdf(data: ArrayBuffer) {
  const pdfjs = await import('pdfjs-dist');
  const workerUrl = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default;
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
  return pdfjs.getDocument({ data: new Uint8Array(data) }).promise;
}

/**
 * 스캔 PDF 페이지를 그림으로 그린다 (글자 인식용). 해상도는 긴 변 약 2000px.
 * ArrayBuffer 는 pdf.js 가 넘겨받아 비우므로 매번 새로 읽은 것을 넘긴다.
 */
export async function renderPdfPages(data: ArrayBuffer, pages: number[]): Promise<HTMLCanvasElement[]> {
  const doc = await loadPdf(data);
  const out: HTMLCanvasElement[] = [];
  for (const p of pages) {
    if (p < 1 || p > doc.numPages) continue;
    const page = await doc.getPage(p);
    const base = page.getViewport({ scale: 1 });
    const scale = Math.min(4, 2000 / Math.max(base.width, base.height));
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport }).promise;
    out.push(canvas);
  }
  await doc.destroy();
  return out;
}

export async function extractPdfLines(data: ArrayBuffer, fromPage = 1, toPage?: number): Promise<PdfTextResult> {
  const pdfjs = await import('pdfjs-dist');
  const workerUrl = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default;
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
  const doc = await pdfjs.getDocument({ data: new Uint8Array(data) }).promise;
  const last = Math.min(doc.numPages, toPage && toPage >= fromPage ? toPage : doc.numPages);
  const lines: string[] = [];
  const emptyPages: number[] = [];
  for (let p = Math.max(1, fromPage); p <= last; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    const items = content.items.filter((it): it is (typeof content.items)[number] & { str: string; transform: number[]; width: number } => 'str' in it);
    const pageLines = textItemsToLines(items);
    if (pageLines.join('').length < 5) emptyPages.push(p);
    lines.push(...pageLines);
  }
  await doc.destroy();
  return { pageCount: doc.numPages, lines, emptyPages };
}
