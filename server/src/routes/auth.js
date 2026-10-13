import { Router } from 'express'
import bcrypt from 'bcrypt'
import jwt from 'jsonwebtoken'
import prisma from '../prisma.js'
import { requireAuth } from '../middleware/auth.js'

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

// Refresh token only carries the userId. The role/companyId are
// read fresh from the database when a new access token is issued.
function createRefreshToken(user) {
  return jwt.sign({ userId: user.id }, process.env.JWT_REFRESH_SECRET, {
    expiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '7d',
  })
}

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

// ---------- POST /api/auth/register ----------
// Two ways to register:
//   1. No inviteCode: creates a NEW company and makes this person its ADMIN.
//   2. With inviteCode (the company's ID, shown to admins in Settings -> Workspace):
//      joins that EXISTING company as a MEMBER, so the whole team shares one companyId.
// role is NEVER accepted from the client. The invite code is a random UUID, so it
// cannot be guessed; typing a company name never joins an existing company.
router.post('/register', async (req, res) => {
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
    if (typeof password !== 'string' || password.length < 8) {
      return res.status(400).json({ message: 'Password must be at least 8 characters' })
    }
    if (password.length > 72) {
      return res.status(400).json({ message: 'Password must be at most 72 characters' })
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
      refreshToken: createRefreshToken(user),
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
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body || {}

    if (typeof email !== 'string' || typeof password !== 'string' || !email.trim() || !password) {
      return res.status(400).json({ message: 'Email and password are required' })
    }

    const user = await prisma.user.findUnique({
      where: { email: email.trim().toLowerCase() },
      include: { company: true },
    })

    // Same message for unknown email and wrong password,
    // so nobody can find out which emails are registered
    const passwordOk = user ? await bcrypt.compare(password, user.password) : false
    if (!user || !passwordOk) {
      return res.status(401).json({ message: 'Invalid email or password' })
    }

    res.json({
      accessToken: createAccessToken(user),
      refreshToken: createRefreshToken(user),
      user: publicUser(user),
    })
  } catch (err) {
    console.error('Login error:', err)
    res.status(500).json({ message: 'Something went wrong' })
  }
})

// ---------- POST /api/auth/refresh ----------
router.post('/refresh', async (req, res) => {
  try {
    const { refreshToken } = req.body || {}
    if (typeof refreshToken !== 'string' || !refreshToken) {
      return res.status(400).json({ message: 'Refresh token is required' })
    }

    let payload
    try {
      payload = jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET, { algorithms: ['HS256'] })
    } catch {
      return res.status(401).json({ message: 'Invalid or expired refresh token' })
    }

    if (typeof payload.userId !== 'string' || !payload.userId) {
      return res.status(401).json({ message: 'Invalid or expired refresh token' })
    }

    // Read the user again so role/company changes (or a deleted user) are respected
    const user = await prisma.user.findUnique({ where: { id: payload.userId } })
    if (!user) {
      return res.status(401).json({ message: 'Invalid or expired refresh token' })
    }

    res.json({ accessToken: createAccessToken(user) })
  } catch (err) {
    console.error('Refresh error:', err)
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