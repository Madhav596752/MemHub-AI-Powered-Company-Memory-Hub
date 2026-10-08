import jwt from 'jsonwebtoken'

// Checks the "Authorization: Bearer <token>" header.
// If the token is valid, puts { userId, companyId, role } on req.user.
// Always use req.user.companyId for company-scoped queries,
// never a companyId sent by the frontend.
export function requireAuth(req, res, next) {
  const header = req.headers.authorization || ''
  const [scheme, token] = header.split(' ')

  if (scheme !== 'Bearer' || !token) {
    return res.status(401).json({ message: 'Authentication required' })
  }

  try {
    const payload = jwt.verify(token, process.env.JWT_ACCESS_SECRET, { algorithms: ['HS256'] })

    // Prisma silently ignores `where: { companyId: undefined }` (it would match
    // every company), so never let a token without these fields through.
    if (!payload.userId || !payload.companyId || !payload.role) {
      return res.status(401).json({ message: 'Invalid token' })
    }

    req.user = {
      userId: payload.userId,
      companyId: payload.companyId,
      role: payload.role,
    }
    next()
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ message: 'Token expired' })
    }
    return res.status(401).json({ message: 'Invalid token' })
  }
}

// Use after requireAuth. Example: router.delete('/x', requireAuth, requireRole('ADMIN'), handler)
export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ message: 'You do not have permission to do this' })
    }
    next()
  }
}
