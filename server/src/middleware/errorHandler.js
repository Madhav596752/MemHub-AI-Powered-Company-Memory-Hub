// JSON 404 for unknown API routes (instead of Express's HTML page).
export function apiNotFound(req, res) {
  res.status(404).json({ message: 'Not found' })
}

// Last-resort error handler. Clients only ever get a short generic message: no stack traces,
// no error text, no secrets. The real error is logged on the server.
export function apiErrorHandler(err, req, res, next) {
  if (res.headersSent) return next(err)
  if (err?.type === 'entity.parse.failed') {
    return res.status(400).json({ message: 'Invalid request body' })
  }
  if (err?.type === 'entity.too.large') {
    return res.status(413).json({ message: 'Request body is too large' })
  }
  console.error('Unhandled error:', err)
  res.status(500).json({ message: 'Something went wrong' })
}
