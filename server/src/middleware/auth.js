import jwt from 'jsonwebtoken'

// Checks the "Authorization: Bearer <access-token>" header.
// On success sets req.user = { userId, companyId, role } (taken from the signed JWT,
// see createAccessToken in routes/auth.js). Never trusts companyId from the request body.
export function requireAuth(req, res, next) {
  const header = req.headers.authorization || ''
  const [scheme, token] = header.split(' ')

  if (scheme !== 'Bearer' || !token) {
    return res.status(401).json({ success: false, message: 'Authentication required' })
  }

  try {
    const payload = jwt.verify(token, process.env.JWT_ACCESS_SECRET, { algorithms: ['HS256'] })
    if (!payload.userId || !payload.companyId) {
      return res.status(401).json({ success: false, message: 'Invalid or expired token' })
    }
    req.user = { userId: payload.userId, companyId: payload.companyId, role: payload.role }
    next()
  } catch {
    res.status(401).json({ success: false, message: 'Invalid or expired token' })
  }
}

// Use after requireAuth for admin-only routes (RBAC).
export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ success: false, message: 'You do not have permission to do this' })
    }
    next()
  }
}
