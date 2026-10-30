// Splits a document's extractedText into ordered, overlapping chunks.
//
// Chunks are exact slices of the original text (nothing is trimmed or rewritten),
// and every chunk records its start/end offsets, so
//   document.extractedText.slice(chunk.startChar, chunk.endChar) === chunk.text
//
// Defaults suit all-MiniLM-L6-v2, which reads at most 256 tokens (~1000 English characters).
// Longer chunks would be silently truncated by the model.
export const DEFAULT_CHUNK_SIZE = 1000 // characters
export const DEFAULT_CHUNK_OVERLAP = 200 // characters

// Preferred places to end a chunk, best first. The separator stays with the chunk before it.
const BREAKS = ['\n\n', '\n', '. ', '? ', '! ', ' ']

function readEnvInt(name, fallback) {
  const value = Number.parseInt(process.env[name] ?? '', 10)
  return Number.isInteger(value) ? value : fallback
}

// chunkText(text, { chunkSize, overlap }) -> [{ chunkIndex, text, startChar, endChar }]
// Empty / whitespace-only text gives []. Text shorter than chunkSize gives one chunk.
export function chunkText(text, options = {}) {
  const chunkSize = options.chunkSize ?? readEnvInt('CHUNK_SIZE', DEFAULT_CHUNK_SIZE)
  const overlap = options.overlap ?? readEnvInt('CHUNK_OVERLAP', DEFAULT_CHUNK_OVERLAP)

  if (!Number.isInteger(chunkSize) || chunkSize < 1) {
    throw new Error('chunkSize must be a positive integer')
  }
  if (!Number.isInteger(overlap) || overlap < 0 || overlap >= chunkSize) {
    throw new Error('overlap must be an integer from 0 up to chunkSize - 1')
  }

  const source = typeof text === 'string' ? text : ''
  const chunks = []
  let start = 0

  while (start < source.length) {
    let end = Math.min(start + chunkSize, source.length)

    // Not at the end of the text: try to end on a paragraph/sentence/word boundary
    // instead of cutting a word in half. Only look in the back of the window so the
    // chunk stays reasonably full and the next start always moves forward.
    if (end < source.length) {
      const earliestEnd = Math.min(start + Math.max(overlap + 1, Math.ceil(chunkSize / 2)), end)
      for (const sep of BREAKS) {
        const at = source.lastIndexOf(sep, end - sep.length)
        if (at !== -1 && at + sep.length >= earliestEnd) {
          end = at + sep.length
          break
        }
      }
    }

    const piece = source.slice(start, end)
    if (piece.trim()) {
      chunks.push({ chunkIndex: chunks.length, text: piece, startChar: start, endChar: end })
    }

    if (end >= source.length) break
    start = end - overlap // overlap < chunkSize and end >= start + overlap + 1, so this always advances
  }

  return chunks
}

// chunkDocument(doc) takes a Document row (needs id, companyId, originalName, extractedText)
// and returns chunks that carry what is needed to find the original document later.
export function chunkDocument(doc, options) {
  return chunkText(doc.extractedText, options).map((chunk) => ({
    documentId: doc.id,
    companyId: doc.companyId,
    documentName: doc.originalName,
    ...chunk,
  }))
}
