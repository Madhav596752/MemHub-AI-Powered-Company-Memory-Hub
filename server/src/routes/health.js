import { Router } from 'express'

const router = Router()

router.get('/', (req, res) => {
  res.json({
    status: 'ok',
    message: 'MemHub API is running',
  })
})

export default router
