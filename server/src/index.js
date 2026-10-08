import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import healthRouter from './routes/health.js'
import authRouter from './routes/auth.js'

// Fail early with a clear message if the JWT secrets are missing
if (!process.env.JWT_ACCESS_SECRET || !process.env.JWT_REFRESH_SECRET) {
  console.error('Missing JWT_ACCESS_SECRET or JWT_REFRESH_SECRET in server/.env')
  process.exit(1)
}

if (process.env.JWT_ACCESS_SECRET === process.env.JWT_REFRESH_SECRET) {
  console.error('JWT_ACCESS_SECRET and JWT_REFRESH_SECRET must be different')
  process.exit(1)
}

const app = express()

const PORT = process.env.PORT || 5000
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173'

app.use(cors({ origin: FRONTEND_URL }))
app.use(express.json())

app.use('/api/health', healthRouter)
app.use('/api/auth', authRouter)

// Unknown API routes -> JSON 404 (instead of Express's HTML page)
app.use('/api', (req, res) => {
  res.status(404).json({ message: 'Not found' })
})

// Last-resort error handler (e.g. malformed JSON body). Never leaks stack traces.
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ message: 'Invalid request body' })
  }
  console.error('Unhandled error:', err)
  res.status(500).json({ message: 'Something went wrong' })
})

app.listen(PORT, () => {
  console.log(`MemHub API running on http://localhost:${PORT}`)
})
