#!/usr/bin/env node
/**
 * 글자 인식(OCR) 파일을 웹앱 public 폴더로 복사한다 (web/public/ocr).
 * tesseract.js 는 기본으로 엔진·언어 데이터를 CDN 에서 받으므로, 앱 안에 함께 두어 외부 호출 없이 동작하게 한다.
 *  - worker.min.js            : tesseract.js 작업자
 *  - core/*-lstm.wasm.js      : 엔진 (LSTM 전용, SIMD 지원 여부에 따라 하나를 고름)
 *  - lang/{kor,eng}.traineddata.gz : 언어 데이터 (4.0.0_best_int, 작은 정수형 모델)
 * 라이선스: tesseract.js / tesseract.js-core Apache-2.0, @tesseract.js-data/* MIT
 */
import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const nm = join(root, 'node_modules');
const out = join(root, 'web', 'public', 'ocr');

const files = [
  [join(nm, 'tesseract.js', 'dist', 'worker.min.js'), join(out, 'worker.min.js')],
  [join(nm, 'tesseract.js-core', 'tesseract-core-lstm.wasm.js'), join(out, 'core', 'tesseract-core-lstm.wasm.js')],
  [join(nm, 'tesseract.js-core', 'tesseract-core-simd-lstm.wasm.js'), join(out, 'core', 'tesseract-core-simd-lstm.wasm.js')],
  [join(nm, 'tesseract.js-core', 'tesseract-core-relaxedsimd-lstm.wasm.js'), join(out, 'core', 'tesseract-core-relaxedsimd-lstm.wasm.js')],
  [join(nm, '@tesseract.js-data', 'kor', '4.0.0_best_int', 'kor.traineddata.gz'), join(out, 'lang', 'kor.traineddata.gz')],
  [join(nm, '@tesseract.js-data', 'eng', '4.0.0_best_int', 'eng.traineddata.gz'), join(out, 'lang', 'eng.traineddata.gz')],
];

let copied = 0;
for (const [src, dst] of files) {
  if (!existsSync(src)) {
    console.error(`OCR 파일이 없습니다: ${src}\n  npm install 을 먼저 실행하세요.`);
    process.exit(1);
  }
  mkdirSync(dirname(dst), { recursive: true });
  if (existsSync(dst) && statSync(dst).size === statSync(src).size) continue;
  copyFileSync(src, dst);
  copied++;
}
console.log(`OCR 파일 준비 완료 (${copied}개 복사, 위치: web/public/ocr)`);
