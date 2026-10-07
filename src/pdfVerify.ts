import { readFileSync } from 'node:fs';
// @ts-ignore: import the lib file directly to avoid pdf-parse's debug side effect
import pdfParse from 'pdf-parse/lib/pdf-parse.js';

const DASHES = '‐‑‒–—―−';
const YEAR = '(?<!\\d)(?:19|20)\\d{2}(?!\\d)';
const DATE_DASH = new RegExp(`${YEAR}[^\\S\\n]*[${DASHES}]|[${DASHES}][^\\S\\n]*${YEAR}`);

const fold = (s: string) => s.normalize('NFC').replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, ' ').toLowerCase();

export interface PdfCheckOpts {
  pages: number;
  mustContain: string[];
  /** Entries compared by digits only (e.g. phone numbers), tolerant of formatting. */
  digitsContain?: string[];
  minChars?: number;
}

export function checkText(text: string, numPages: number, opts: PdfCheckOpts): string[] {
  const fails: string[] = [];
  if (numPages !== opts.pages) fails.push(`expected ${opts.pages} pages, got ${numPages}`);
  if (text.trim().length < (opts.minChars ?? 200)) fails.push('text layer empty or too short (image-only PDF?)');
  const folded = fold(text);
  for (const s of opts.mustContain) if (s && !folded.includes(fold(s))) fails.push(`missing literal text: ${s}`);
  const textDigits = text.replace(/\D/g, '');
  for (const s of opts.digitsContain ?? []) {
    const d = (s ?? '').replace(/\D/g, '');
    if (d && !textDigits.includes(d)) fails.push(`missing digits: ${s}`);
  }
  if (/\(cid:\d+\)/.test(text)) fails.push('garbled glyph markers (cid:NNN) in text layer');
  if (text.includes('�')) fails.push('replacement characters in text layer');
  return fails;
}

/** Non-blocking findings: logged by verifyPdf, never thrown. */
export function checkWarnings(text: string): string[] {
  const warnings: string[] = [];
  if (DATE_DASH.test(text)) warnings.push('date range uses a non-ASCII dash, which some ATS importers may drop');
  return warnings;
}

export async function verifyPdf(pdfPath: string, opts: PdfCheckOpts): Promise<void> {
  // Copy into a standalone Uint8Array: small Buffers live in Node's shared 8KB pool and
  // pdf.js ignores byteOffset, so it would otherwise read unrelated bytes.
  const data = await pdfParse(Uint8Array.from(readFileSync(pdfPath)));
  const fails = checkText(data.text, data.numpages, opts);
  // stderr only: MCP servers use stdout for the protocol.
  for (const w of checkWarnings(data.text)) console.error(`[pdfVerify] warning: ${w}`);
  if (fails.length) throw new Error(`PDF verification failed: ${fails.join('; ')}`);
}
