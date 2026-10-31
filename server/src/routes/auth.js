import { Router } from 'express'
import bcrypt from 'bcrypt'
import jwt from 'jsonwebtoken'
import prisma from '../prisma.js'
import { requireAuth } from '../middleware/auth.js'
import { issueRefreshToken, rotateRefreshToken, revokeSessionByToken, revokeAllSessionsForUser } from '../utils/refreshTokens.js'
import { registerLimiter, loginLimiter, loginAccountLimiter, refreshLimiter, logoutLimiter } from '../middleware/rateLimit.js'

const router = Router()

const SALT_ROUNDS = 10

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// ---------- helpers ----------

function createAccessToken(user) {
  return jwt.sign(
    { userId: user.id, companyId: user.companyId, role: user.role },
    process.env.JWT_ACCESS_SECRET,
    { expiresIn: process.env.JWT_ACCESS_EXPIRES_IN || '15m' }
  )
}

// Refresh tokens are created and tracked in utils/refreshTokens.js (issueRefreshToken / rotateRefreshToken).
// They only carry the userId (+ session ids); role/companyId are read fresh from the database on refresh.

// Never send the password hash to the client
function publicUser(user) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    companyId: user.companyId,
    companyName: user.company?.name,
  }
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
}

// bcrypt only uses the first 72 BYTES of a password, so the limit is in bytes (a 40-character password
// of 2-byte characters would otherwise be silently truncated).
const MAX_PASSWORD_BYTES = 72
const COMMON_PASSWORDS = new Set([
  'password', 'password1', 'password123', '12345678', '123456789', '1234567890', 'qwertyui', 'qwerty123',
  'iloveyou', 'admin123', 'welcome1', 'letmein1', '11111111', '00000000', 'abcd1234', 'abc12345',
])

// Returns an error message, or null when the password is acceptable.
function passwordProblem(password, email) {
  if (password.length < 8) return 'Password must be at least 8 characters'
  if (Buffer.byteLength(password, 'utf8') > MAX_PASSWORD_BYTES) return 'Password must be at most 72 bytes long'
  if (!password.trim()) return 'Password cannot be only spaces'
  const lower = password.toLowerCase()
  if (COMMON_PASSWORDS.has(lower) || lower === email) return 'This password is too common. Please choose a different one'
  return null
}

// Used when the email is unknown, so a failed login takes as long as a wrong password (no timing oracle).
let dummyHash
function getDummyHash() {
  dummyHash ??= bcrypt.hash(`dummy-${Math.random()}`, SALT_ROUNDS)
  return dummyHash
}

// ---------- POST /api/auth/register ----------
// Two ways to register:
//   1. No inviteCode: creates a NEW company and makes this person its ADMIN.
//   2. With inviteCode (the company's ID, shown to admins in Settings -> Workspace):
//      joins that EXISTING company as a MEMBER, so the whole team shares one companyId.
// role is NEVER accepted from the client. The invite code is a random UUID, so it
// cannot be guessed; typing a company name never joins an existing company.
router.post('/register', registerLimiter, async (req, res) => {
  try {
    const { name, email, password, companyName, inviteCode } = req.body || {}

    const code = typeof inviteCode === 'string' ? inviteCode.trim() : ''
    const joining = code.length > 0

    if (typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ message: 'Name is required' })
    }
    if (typeof email !== 'string' || !isValidEmail(email.trim())) {
      return res.status(400).json({ message: 'A valid email is required' })
    }
    if (typeof password !== 'string') {
      return res.status(400).json({ message: 'Password must be at least 8 characters' })
    }
    const problem = passwordProblem(password, email.trim().toLowerCase())
    if (problem) {
      return res.status(400).json({ message: problem })
    }
    if (!joining && (typeof companyName !== 'string' || !companyName.trim())) {
      return res.status(400).json({ message: 'Company name is required' })
    }
    if (
      name.trim().length > 100 ||
      (typeof companyName === 'string' && companyName.trim().length > 100) ||
      email.trim().length > 254
    ) {
      return res.status(400).json({ message: 'Name, company name or email is too long' })
    }

    const cleanEmail = email.trim().toLowerCase()

    const existing = await prisma.user.findUnique({ where: { email: cleanEmail } })
    if (existing) {
      return res.status(409).json({ message: 'An account with this email already exists' })
    }

    // Joining an existing company: the invite code must match a real company
    let joinCompany = null
    if (joining) {
      if (!UUID_REGEX.test(code)) {
        return res.status(400).json({ message: 'Invalid invite code' })
      }
      joinCompany = await prisma.company.findUnique({ where: { id: code } })
      if (!joinCompany) {
        return res.status(400).json({ message: 'Invalid invite code' })
      }
    }

    const hashedPassword = await bcrypt.hash(password, SALT_ROUNDS)

    let user
    if (joinCompany) {
      user = await prisma.user.create({
        data: {
          name: name.trim(),
          email: cleanEmail,
          password: hashedPassword,
          role: 'MEMBER',
          companyId: joinCompany.id,
        },
        include: { company: true },
      })
    } else {
      // Create company + admin user together (both succeed or both fail)
      user = await prisma.$transaction(async (tx) => {
        const company = await tx.company.create({ data: { name: companyName.trim() } })
        return tx.user.create({
          data: {
            name: name.trim(),
            email: cleanEmail,
            password: hashedPassword,
            role: 'ADMIN',
            companyId: company.id,
          },
          include: { company: true },
        })
      })
    }

    res.status(201).json({
      accessToken: createAccessToken(user),
      refreshToken: await issueRefreshToken(user),
      user: publicUser(user),
    })
  } catch (err) {
    // Two requests with the same email at the same moment
    if (err.code === 'P2002') {
      return res.status(409).json({ message: 'An account with this email already exists' })
    }
    console.error('Register error:', err)
    res.status(500).json({ message: 'Something went wrong' })
  }
})

// ---------- POST /api/auth/login ----------
router.post('/login', loginLimiter, loginAccountLimiter, async (req, res) => {
  try {
    const { email, password } = req.body || {}

    if (typeof email !== 'string' || typeof password !== 'string' || !email.trim() || !password) {
      return res.status(400).json({ message: 'Email and password are required' })
    }
    if (email.length > 254 || password.length > 1000) {
      return res.status(400).json({ message: 'Email or password is too long' })
    }

    const user = await prisma.user.findUnique({
      where: { email: email.trim().toLowerCase() },
      include: { company: true },
    })

    // Same message for unknown email and wrong password,
    // so nobody can find out which emails are registered
    const passwordOk = await bcrypt.compare(password, user ? user.password : await getDummyHash())
    if (!user || !passwordOk) {
      return res.status(401).json({ message: 'Invalid email or password' })
    }

    res.json({
      accessToken: createAccessToken(user),
      refreshToken: await issueRefreshToken(user),
      user: publicUser(user),
    })
  } catch (err) {
    console.error('Login error:', err)
    res.status(500).json({ message: 'Something went wrong' })
  }
})

// ---------- POST /api/auth/refresh ----------
// Body: { refreshToken }. Refresh tokens are single-use: the response contains a NEW refreshToken that
// the client must store (the old one stops working). Every failure (bad, expired, revoked, replayed,
// legacy token) is the same 401 so nothing is revealed about why.
router.post('/refresh', refreshLimiter, async (req, res) => {
  try {
    const { refreshToken } = req.body || {}
    if (typeof refreshToken !== 'string' || !refreshToken) {
      return res.status(400).json({ message: 'Refresh token is required' })
    }

    const result = await rotateRefreshToken(refreshToken)
    if (!result.ok) {
      if (result.reason === 'reuse-detected') {
        console.warn('Refresh token reuse detected: session revoked')
      }
      return res.status(401).json({ message: 'Invalid or expired refresh token' })
    }

    res.json({ accessToken: createAccessToken(result.user), refreshToken: result.refreshToken })
  } catch (err) {
    console.error('Refresh error:', err)
    res.status(500).json({ message: 'Something went wrong' })
  }
})

// ---------- POST /api/auth/logout ----------
// Body: { refreshToken }. Revokes the session that token belongs to (only that session). No access token
// is required, so logout still works after the access token expired. Always answers 200 for any string
// (valid, expired, unknown or already revoked) so it is safe to call twice.
// The short-lived access token that was already issued stays valid until it expires (see JWT_ACCESS_EXPIRES_IN).
router.post('/logout', logoutLimiter, async (req, res) => {
  try {
    const { refreshToken } = req.body || {}
    if (typeof refreshToken !== 'string' || !refreshToken) {
      return res.status(400).json({ message: 'Refresh token is required' })
    }
    await revokeSessionByToken(refreshToken)
    res.json({ success: true })
  } catch (err) {
    console.error('Logout error:', err)
    res.status(500).json({ message: 'Something went wrong' })
  }
})

// ---------- POST /api/auth/logout-all ----------
// Revokes every session of the signed-in user (all devices). Other users are never affected.
router.post('/logout-all', logoutLimiter, requireAuth, async (req, res) => {
  try {
    await revokeAllSessionsForUser(req.user.userId)
    res.json({ success: true })
  } catch (err) {
    console.error('Logout-all error:', err)
    res.status(500).json({ message: 'Something went wrong' })
  }
})

// ---------- GET /api/auth/me ----------
router.get('/me', requireAuth, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.userId },
      include: { company: true },
    })
    if (!user) {
      return res.status(401).json({ message: 'User no longer exists' })
    }
    res.json(publicUser(user))
  } catch (err) {
    console.error('Me error:', err)
    res.status(500).json({ message: 'Something went wrong' })
  }
})

export default router