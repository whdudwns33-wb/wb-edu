/**
 * 글자 인식(OCR): 목차 사진이나 스캔 PDF 페이지에서 글자를 읽는다.
 *  - tesseract.js 를 필요할 때만 불러온다 (첫 화면 번들에 포함하지 않음)
 *  - 엔진·한국어/영어 데이터는 앱 안(/ocr/)에서 받는다. 외부 서버로 이미지나 요청을 보내지 않는다
 *  - 인식 결과에는 오탈자가 있을 수 있으므로 반드시 사람이 확인·수정한 뒤 미리보기로 넘긴다
 */
import { normalizeOcrLine, ocrLinesToTocLines, type OcrLineInput } from '@wb/shared';

export interface OcrProgress {
  status: string;
  /** 0~1 */
  progress: number;
  page?: number;
  pageCount?: number;
}

export interface OcrResult {
  lines: string[];
  /** 평균 신뢰도 (0~100) */
  confidence: number;
}

export async function recognizeImages(images: Array<Blob | HTMLCanvasElement>, onProgress?: (p: OcrProgress) => void): Promise<OcrResult> {
  const { createWorker } = await import('tesseract.js');
  let page = 0;
  const worker = await createWorker(['kor', 'eng'], 1 /* OEM.LSTM_ONLY */, {
    workerPath: '/ocr/worker.min.js',
    corePath: '/ocr/core',
    langPath: '/ocr/lang',
    gzip: true,
    cacheMethod: 'none', // 브라우저 저장소에 언어 데이터를 남기지 않음
    logger: (m: { status: string; progress: number }) => onProgress?.({ status: m.status, progress: m.progress, page: page + 1, pageCount: images.length }),
  });
  try {
    const lines: string[] = [];
    const confidences: number[] = [];
    for (; page < images.length; page++) {
      // blocks: 줄·단어의 위치. 2단 목차를 '왼쪽 단 → 오른쪽 단' 순서로 다시 읽는 데 쓴다
      const { data } = await worker.recognize(images[page], {}, { text: true, blocks: true });
      confidences.push(data.confidence);
      const ocrLines: OcrLineInput[] = (data.blocks ?? []).flatMap((b) =>
        b.paragraphs.flatMap((pa) => pa.lines.map((l) => ({ bbox: l.bbox, text: l.text, words: l.words.map((w) => ({ text: w.text, bbox: w.bbox })) }))),
      );
      if (ocrLines.length) lines.push(...ocrLinesToTocLines(ocrLines));
      else {
        // 위치 정보가 없으면 엔진이 준 텍스트 순서를 그대로 쓴다
        for (const raw of data.text.split('\n')) {
          const l = normalizeOcrLine(raw);
          if (l) lines.push(l);
        }
      }
    }
    return { lines, confidence: confidences.length ? Math.round(confidences.reduce((a, b) => a + b, 0) / confidences.length) : 0 };
  } finally {
    await worker.terminate();
  }
}
