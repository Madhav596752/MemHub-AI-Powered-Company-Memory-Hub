import fs from 'fs/promises'
import mammoth from 'mammoth'
import { PDFParse } from 'pdf-parse'

export const PDF_MIME = 'application/pdf'
export const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
export const TXT_MIME = 'text/plain'

// Tidy extracted text so it is safe to store in PostgreSQL and easy to chunk later.
function cleanText(text) {
  return String(text || '')
    .replace(/\u0000/g, '') // PostgreSQL text columns cannot contain NUL characters
    .replace(/^\uFEFF/, '') // BOM
    .replace(/\r\n?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

// extractText(filePath, mimeType) -> { text, pageCount }
// pageCount is only known for PDFs (null otherwise).
// Throws if the type is not supported or the file cannot be read.
export async function extractText(filePath, mimeType) {
  if (mimeType === PDF_MIME) {
    const parser = new PDFParse({ data: await fs.readFile(filePath) })
    try {
      const result = await parser.getText()
      // Join the pages ourselves (the default text has "-- 1 of 2 --" markers in it)
      const text = result.pages.map((page) => page.text).join('\n\n')
      return { text: cleanText(text), pageCount: result.total || null }
    } finally {
      await parser.destroy()
    }
  }

  if (mimeType === DOCX_MIME) {
    const result = await mammoth.extractRawText({ path: filePath })
    return { text: cleanText(result.value), pageCount: null }
  }

  if (mimeType === TXT_MIME) {
    return { text: cleanText(await fs.readFile(filePath, 'utf8')), pageCount: null }
  }

  throw new Error(`Unsupported file type: ${mimeType}`)
}
