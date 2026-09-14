import { PDFParse } from 'pdf-parse';

// Extract text from a PDF buffer. Returns { text, pageCount } or null on
// failure. Truncates very long PDFs so we don't blow the model context.
// Shared by the chat upload path (server.js) and the Documents tab
// (documents.js) — one PDF-reading rule for both.
export async function extractPdfText(buffer, filename) {
  try {
    const parser = new PDFParse({ data: new Uint8Array(buffer) });
    const result = await parser.getText();
    await parser.destroy();
    const fullText = (result?.text || '').trim();
    const MAX_CHARS = Number(process.env.PDF_TEXT_MAX_CHARS || 25000);
    const truncated = fullText.length > MAX_CHARS;
    return {
      text:      truncated ? fullText.slice(0, MAX_CHARS) + '\n…[truncated]…' : fullText,
      truncated,
      fullLength: fullText.length,
      pageCount: result?.pages?.length ?? null,
    };
  } catch (err) {
    console.error(`PDF parse error for ${filename}:`, err.message);
    return null;
  }
}
