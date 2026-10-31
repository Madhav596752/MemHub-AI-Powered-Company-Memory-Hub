import { Router } from 'express'
import { checkRedisHealth } from '../utils/redisCache.js'

const router = Router()

// GET /api/health -> always 200 while the API itself runs. Redis is an optional cache, so its state is only
// REPORTED here ('disabled' | 'ok' | 'unavailable'), it never turns the health check into a failure.
export async function healthHandler(req, res) {
  let redis
  try {
    redis = await checkRedisHealth() // never throws; the catch is only a safety net
  } catch {
    redis = { configured: true, status: 'unavailable' }
  }
  res.json({
    status: 'ok',
    message: 'MemHub API is running',
    redis,
  })
}

router.get('/', healthHandler)

export default router
