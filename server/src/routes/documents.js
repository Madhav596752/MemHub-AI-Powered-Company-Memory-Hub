import { Router } from 'express'
import multer from 'multer'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { randomUUID } from 'crypto'
import prisma from '../prisma.js'
import { requireAuth } from '../middleware/auth.js'
import { requirePermission } from '../middleware/permissions.js'
import { isCloudinaryConfigured, uploadDocumentFile, deleteDocumentFile } from '../cloudinary.js'
import { extractText, PDF_MIME, DOCX_MIME, TXT_MIME } from '../utils/textExtractor.js'
import { indexDocument, deleteDocumentChunks, RagError } from '../utils/vectorStore.js'
import { processDocumentGraph } from '../utils/graphIngest.js'
import { deleteDocumentGraph } from '../utils/graphStore.js'
import { GraphError } from '../utils/neo4j.js'
import {
  beginKnowledgeChange, graphResultEffect, graphWriteEffect, vectorDeleteEffect, vectorWriteEffect,
} from '../utils/knowledgeVersion.js'

const router = Router()

const MAX_FILE_SIZE = 10 * 1024 * 1024 // 10 MB

// Allowed types, decided by file extension (never by anything the client calls the file).
const FILE_TYPES = {
  '.pdf': { label: 'PDF', mime: PDF_MIME },
  '.docx': { label: 'DOCX', mime: DOCX_MIME },
  '.txt': { label: 'TXT', mime: TXT_MIME },
}

// Temporary upload folder (outside the project, so nothing can be committed to Git).
// Files here are always deleted after the request finishes.
const TMP_DIR = path.join(os.tmpdir(), 'memhub-uploads')

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      fs.mkdir(TMP_DIR, { recursive: true }).then(() => cb(null, TMP_DIR), cb)
    },
    // Random temp name; the client's filename is never used as a path.
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase()
      cb(null, `${randomUUID()}${FILE_TYPES[ext] ? ext : ''}`)
    },
  }),
  limits: { fileSize: MAX_FILE_SIZE, files: 1 },
  defParamCharset: 'utf8', // so names like "résumé.pdf" are not garbled
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase()
    if (!FILE_TYPES[ext]) {
      const err = new Error('Only PDF, DOCX and TXT files are allowed')
      err.status = 400
      return cb(err)
    }
    cb(null, true)
  },
})

// Runs multer and turns its errors into our JSON format.
function handleUpload(req, res, next) {
  upload.single('file')(req, res, (err) => {
    if (!err) return next()
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ success: false, message: 'File is too large (maximum 10 MB)' })
    }
    if (err.code === 'LIMIT_UNEXPECTED_FILE' || err.code === 'LIMIT_FILE_COUNT') {
      return res.status(400).json({ success: false, message: 'Upload exactly one file in the "file" field' })
    }
    if (err.status === 400 || err instanceof multer.MulterError) {
      return res.status(400).json({ success: false, message: err.status ? err.message : 'Invalid upload' })
    }
    // Not a multer error (e.g. broken multipart body, disk problem)
    if (err.message && /multipart|boundary|Unexpected end of form/i.test(err.message)) {
      return res.status(400).json({ success: false, message: 'Invalid upload request' })
    }
    console.error('Upload error:', err)
    res.status(500).json({ success: false, message: 'Something went wrong' })
  })
}

// ---------- helpers ----------

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Safe display name: no folders, no control characters, limited length.
function cleanFileName(name) {
  const base = path.basename(String(name).replace(/\\/g, '/'))
  return base.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 200) || 'document'
}

// Check the real content matches the extension (a renamed .exe must not pass as a .pdf).
async function contentLooksValid(filePath, ext) {
  const handle = await fs.open(filePath, 'r')
  try {
    const buf = Buffer.alloc(1024)
    const { bytesRead } = await handle.read(buf, 0, 1024, 0)
    const head = buf.subarray(0, bytesRead)
    if (ext === '.pdf') return head.includes('%PDF-')
    if (ext === '.docx') return head.length >= 4 && head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04
    if (ext === '.txt') return !head.includes(0) // binary files contain NUL bytes
    return false
  } finally {
    await handle.close()
  }
}

const uploaderSelect = { select: { id: true, name: true } }

// Last knowledge-graph processing outcome of a document (GraphIngestion). Loaded through the document
// relation, so it is always scoped to the document's (already company-checked) row.
const graphIngestionSelect = { select: { status: true, entityCount: true, relationshipCount: true, errorCode: true, processedAt: true, updatedAt: true } }

// null = no processing record exists for this document. The internal `pipeline` and `companyId` are not exposed.
function publicIngestion(g) {
  if (!g) return null
  return { status: g.status, entityCount: g.entityCount, relationshipCount: g.relationshipCount, errorCode: g.errorCode, processedAt: g.processedAt, updatedAt: g.updatedAt }
}

// Graph outcome sent to the frontend: status, counts and a safe message only.
function publicGraphResult(g) {
  return { status: g.status, entities: g.entities, relationships: g.relationships, relationshipStatus: g.relationshipStatus, ...(g.code ? { code: g.code, message: g.message } : {}) }
}

// Basic document info sent to the frontend. No companyId, storage IDs or full text.
function publicDocument(doc) {
  const ext = path.extname(doc.fileName).toLowerCase()
  return {
    id: doc.id,
    originalName: doc.originalName,
    fileType: FILE_TYPES[ext]?.label || 'FILE',
    mimeType: doc.mimeType,
    fileSize: doc.fileSize,
    cloudinaryUrl: doc.cloudinaryUrl,
    uploader: doc.uploader ? { id: doc.uploader.id, name: doc.uploader.name } : null,
    createdAt: doc.createdAt,
    // Only present when the query loaded it (list + detail). Absent in the upload response.
    ...(doc.graphIngestion !== undefined ? { graphIngestion: publicIngestion(doc.graphIngestion) } : {}),
  }
}

function serverError(res, label, err) {
  if (err instanceof RagError || err instanceof GraphError) {
    return res.status(err.status).json({ success: false, message: err.message, code: err.code })
  }
  console.error(label, err)
  res.status(500).json({ success: false, message: 'Something went wrong' })
}

// ---------- POST /api/documents ----------
// multipart/form-data with one file in the "file" field.
// companyId and uploadedBy come from the JWT only, never from the request body.
router.post('/', requireAuth, handleUpload, async (req, res) => {
  const file = req.file
  let uploaded = null // { url, publicId } once the file is in Cloudinary
  let change = null // knowledge-base change (Module 9.4), started right before the first write that matters

  try {
    if (!file) {
      return res.status(400).json({ success: false, message: 'No file uploaded. Send a PDF, DOCX or TXT file in the "file" field' })
    }
    if (file.size === 0) {
      return res.status(400).json({ success: false, message: 'The file is empty' })
    }
    if (!isCloudinaryConfigured()) {
      console.error('Cloudinary is not configured (check CLOUDINARY_* in server/.env)')
      return res.status(500).json({ success: false, message: 'File storage is not configured' })
    }

    const ext = path.extname(file.originalname).toLowerCase()
    const type = FILE_TYPES[ext]

    if (!(await contentLooksValid(file.path, ext))) {
      return res.status(400).json({ success: false, message: `This file is not a valid ${type.label} file` })
    }

    // Read the text first, so a file we cannot read is never uploaded or saved.
    let text
    try {
      ;({ text } = await extractText(file.path, type.mime))
    } catch (err) {
      console.error('Text extraction failed:', err.message)
      return res.status(400).json({ success: false, message: `Could not read text from this ${type.label} file. It may be corrupted or password-protected` })
    }
    console.log(`[upload] file="${cleanFileName(file.originalname)}" type=${type.label} extractedTextLength=${text.length}`)
    if (!text) {
      return res.status(400).json({ success: false, code: 'NO_TEXT', message: 'No readable text found in this file (scanned documents are not supported yet)' })
    }

    // Safe stored name, generated by the server
    const fileName = `${randomUUID()}${ext}`
    uploaded = await uploadDocumentFile(file.path, req.user.companyId, fileName)

    // Module 9.4. PostgreSQL, ChromaDB and Neo4j do not share a transaction, so the three writes below can succeed or
    // fail independently. From here until settle() the company's cached answers and graph reads are bypassed (nothing is
    // cached from, or served over, half-written data), and the knowledge-base version advances ONCE at the end, and only
    // if a store really changed. A failure before the first write (e.g. the row cannot be saved) leaves the version alone.
    change = await beginKnowledgeChange(prisma, req.user.companyId, 'upload')

    const doc = await prisma.document.create({
      data: {
        companyId: req.user.companyId, // from JWT
        uploadedBy: req.user.userId, // from JWT
        originalName: cleanFileName(file.originalname),
        fileName,
        mimeType: type.mime,
        fileSize: file.size,
        cloudinaryUrl: uploaded.url,
        cloudinaryPublicId: uploaded.publicId,
        extractedText: text,
      },
      include: { uploader: uploaderSelect },
    })
    change.record('changed') // the row exists now

    // Make the document searchable. The document is already saved, so if indexing fails we
    // still answer 201 but say so clearly; POST /api/documents/:id/reindex retries it.
    // step() records what ChromaDB did: success, a failure that may have changed it, or one that provably did not.
    let indexing
    try {
      indexing = { status: 'indexed', chunks: await change.step(() => indexDocument(doc), { onError: vectorWriteEffect }) }
    } catch (err) {
      console.error('Indexing failed for document', doc.id, err.message)
      indexing = {
        status: 'failed',
        code: err instanceof RagError ? err.code : 'INDEXING_FAILED',
        message: err instanceof RagError ? err.message : 'The document could not be indexed.',
      }
    }
    console.log(`[upload] document=${doc.id} saved, indexing=${indexing.status}`)

    // Knowledge graph (NLP -> Neo4j). Independent of vector indexing: it never throws, and a
    // failure or a missing configuration leaves the upload and the vector index untouched.
    const graph = await processDocumentGraph(doc)
    change.record(graphResultEffect(graph))

    // Publish: advance the version, then end the in-flight state. Done BEFORE answering, so a client that asks a
    // question right after the 201 can never be served an answer from before this upload. Never throws.
    await change.settle()

    res.status(201).json({ success: true, document: publicDocument(doc), indexing, graph: publicGraphResult(graph) })
  } catch (err) {
    // If the file reached Cloudinary but the database save failed, remove it again
    if (uploaded) {
      await deleteDocumentFile(uploaded.publicId).catch((e) => console.error('Cloudinary cleanup failed:', e.message))
    }
    serverError(res, 'Upload document error:', err)
  } finally {
    // Idempotent. Whatever happened above, the lease is released and the version advanced if (and only if) a store changed.
    if (change) await change.settle()
    // Always remove the temporary file
    if (file?.path) await fs.unlink(file.path).catch(() => {})
  }
})

// ---------- GET /api/documents ----------
// Only the logged-in user's company. extractedText is left out of the list (it can be large).
router.get('/', requireAuth, async (req, res) => {
  try {
    const documents = await prisma.document.findMany({
      where: { companyId: req.user.companyId },
      select: {
        id: true,
        originalName: true,
        fileName: true,
        mimeType: true,
        fileSize: true,
        cloudinaryUrl: true,
        createdAt: true,
        uploader: uploaderSelect,
        graphIngestion: graphIngestionSelect,
      },
      orderBy: { createdAt: 'desc' },
    })
    res.json({ success: true, documents: documents.map(publicDocument) })
  } catch (err) {
    serverError(res, 'List documents error:', err)
  }
})

// ---------- GET /api/documents/:id ----------
// Same info as the list, plus the length and a short preview of the extracted text.
router.get('/:id', requireAuth, async (req, res) => {
  try {
    if (!UUID_REGEX.test(req.params.id)) {
      return res.status(400).json({ success: false, message: 'Invalid document ID' })
    }

    // Looked up by id AND the user's company: another company's document is simply "not found"
    const doc = await prisma.document.findFirst({
      where: { id: req.params.id, companyId: req.user.companyId },
      include: { uploader: uploaderSelect, graphIngestion: graphIngestionSelect },
    })
    if (!doc) {
      return res.status(404).json({ success: false, message: 'Document not found' })
    }

    res.json({
      success: true,
      document: {
        ...publicDocument(doc),
        textLength: doc.extractedText.length,
        textPreview: doc.extractedText.slice(0, 1000),
      },
    })
  } catch (err) {
    serverError(res, 'Get document error:', err)
  }
})

// ---------- POST /api/documents/:id/reindex ----------
// Rebuilds the searchable chunks of one document (use it after a failed upload-time indexing).
// Safe to repeat: the old chunks are replaced, never duplicated.
// ADMIN only (document:reindex). The document is still looked up by id AND the caller's company.
router.post('/:id/reindex', requireAuth, requirePermission('document:reindex'), async (req, res) => {
  try {
    if (!UUID_REGEX.test(req.params.id)) {
      return res.status(400).json({ success: false, message: 'Invalid document ID' })
    }

    // Found by id AND the user's company, so another company's document is "not found"
    const doc = await prisma.document.findFirst({
      where: { id: req.params.id, companyId: req.user.companyId },
      select: { id: true, companyId: true, originalName: true, extractedText: true },
    })
    if (!doc) {
      return res.status(404).json({ success: false, message: 'Document not found' })
    }

    // Reindexing rewrites the vector chunks without touching any PostgreSQL row (Module 9.4). The version advances if
    // ChromaDB was (or may have been) changed, also when the run fails half-way: the service deletes the old chunks
    // before it adds the new ones, so a failed run can leave the document without chunks. A failure that provably left
    // ChromaDB alone (embedding failed, nothing to index, token rejected) does NOT advance it.
    const change = await beginKnowledgeChange(prisma, req.user.companyId, 'reindex')
    let chunks
    try {
      chunks = await change.step(() => indexDocument(doc), { onError: vectorWriteEffect })
    } finally {
      await change.settle()
    }
    res.json({ success: true, indexing: { status: 'indexed', chunks } })
  } catch (err) {
    serverError(res, 'Reindex document error:', err)
  }
})

// ---------- DELETE /api/documents/:id ----------
// ADMIN only (document:delete). Being an admin never reaches across companies: the document is found
// by id AND req.user.companyId, so another company's document is "not found" even for its admins.
router.delete('/:id', requireAuth, requirePermission('document:delete'), async (req, res) => {
  try {
    if (!UUID_REGEX.test(req.params.id)) {
      return res.status(400).json({ success: false, message: 'Invalid document ID' })
    }

    const doc = await prisma.document.findFirst({
      where: { id: req.params.id, companyId: req.user.companyId },
      select: { id: true, cloudinaryPublicId: true },
    })
    if (!doc) {
      return res.status(404).json({ success: false, message: 'Document not found' })
    }

    // Vectors first (scoped to this company), then the graph, then Cloudinary, then the database row.
    // If any step fails we keep the database row, so the user can simply try again.
    // Module 9.4: the version advances as soon as ANY store lost this document's data, even when a later step fails
    // and the row is kept (the document is then partly gone and must not be cited from cached answers or graph reads).
    // If the very first step fails without having deleted anything, the version stays.
    const change = await beginKnowledgeChange(prisma, req.user.companyId, 'delete')
    try {
      await change.step(() => deleteDocumentChunks(req.user.companyId, doc.id), { onError: vectorDeleteEffect })
      // Graph facts of this document (shared entities stay if another document still mentions them).
      // A no-op when Neo4j is not configured; if it IS configured and fails, the row is kept for a retry.
      await change.step(() => deleteDocumentGraph(req.user.companyId, doc.id), {
        onError: graphWriteEffect,
        onSuccess: (r) => (r?.skipped ? 'none' : 'changed'),
      })
      await deleteDocumentFile(doc.cloudinaryPublicId) // file storage is not part of the knowledge base
      await change.step(() => prisma.document.deleteMany({ where: { id: doc.id, companyId: req.user.companyId } }), { onError: () => 'none' })
    } finally {
      await change.settle()
    }

    res.json({ success: true, message: 'Document deleted' })
  } catch (err) {
    serverError(res, 'Delete document error:', err)
  }
})

export default router
