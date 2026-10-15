# Bundled Tesseract language data

`eng.traineddata` and `ben.traineddata`, fetched from the official
[tesseract-ocr/tessdata_fast](https://github.com/tesseract-ocr/tessdata_fast)
repository (the "fast" LSTM models — smaller and quicker than `tessdata_best`,
appropriate for the in-browser OCR-as-a-placement-aid use case here, not for
archival-quality text extraction).

Licensed under the Apache License, Version 2.0 (see `LICENSE` in this
directory) — the same license as the Tesseract OCR engine itself, and
explicitly redistributable.

Bundling exactly these two languages (not the full ~100-language tessdata_fast
set) keeps the shipped build size reasonable: the two files together are
about 5 MB, compared to the ~12 MB already shipped for the Tesseract WASM
engine itself (`node_modules/tesseract.js-core`, copied by
`scripts/vite-plugin-pdfjs-assets.ts`). English and Bengali were chosen per
the task brief (IEEE IUBAT's own certificates are issued in English, and
Bengali is Bangladesh's national language). A custom `.traineddata` file for
any other language remains supported via "Advanced" in the OCR dialog
(`OcrDialog.tsx`) — this bundling is additive, not a replacement for that.

To update either file (e.g. picking up an upstream tessdata_fast revision):

    curl -L -o eng.traineddata https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/main/eng.traineddata
    curl -L -o ben.traineddata https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/main/ben.traineddata
