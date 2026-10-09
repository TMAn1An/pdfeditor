import wasmUrl from '@embedpdf/pdfium/pdfium.wasm?url';
import { setPdfiumWasmLoader } from './module';

// The WebAssembly file is bundled with the app and fetched from its own origin.
setPdfiumWasmLoader(async () => {
  const res = await fetch(wasmUrl);
  if (!res.ok) throw new Error(`pdfium.wasm could not be loaded (${res.status}).`);
  return res.arrayBuffer();
});
