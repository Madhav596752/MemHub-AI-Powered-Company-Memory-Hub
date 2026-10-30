import crypto from 'node:crypto'
import jwt from 'jsonwebtoken'
import prisma from '../prisma.js'

// Refresh-token sessions.
//
// One login = one "family" (session). Every refresh token carries { userId, jti, fam }:
//   jti = id of its row in the RefreshToken table, fam = the family (session) id.
// Only a keyed hash (HMAC-SHA256 with JWT_REFRESH_SECRET) of the token is stored, never the token.
//
// Tokens are SINGLE USE. Refreshing atomically marks the presented token 'rotated' and issues the next
// token of the same family. Presenting a token that was already rotated is replay:
//   - within REFRESH_REUSE_GRACE_SECONDS (default 10): rejected, session left alone. This is the benign
//     "two tabs / two requests refreshed at the same moment" race; the loser simply gets 401.
//   - after the grace period: treated as theft, the WHOLE family is revoked (attacker and victim are both
//     signed out of that one session; other sessions and other users are untouched).
// The session keeps its original absolute expiry (same behaviour as before: login + JWT_REFRESH_EXPIRES_IN).

const MAX_TOKEN_LENGTH = 2048

function refreshSecret() {
  return process.env.JWT_REFRESH_SECRET
}

export function hashToken(token) {
  return crypto.createHmac('sha256', refreshSecret()).update(token).digest('hex')
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a))
  const y = Buffer.from(String(b))
  return x.length === y.length && crypto.timingSafeEqual(x, y)
}

function reuseGraceMs() {
  const seconds = Number.parseInt(process.env.REFRESH_REUSE_GRACE_SECONDS ?? '', 10)
  return (Number.isFinite(seconds) && seconds >= 0 && seconds <= 120 ? seconds : 10) * 1000
}

// Signs a token, stores its hash and returns the token. `db` is prisma or a transaction client.
async function createToken(db, { userId, familyId, exp }) {
  const id = crypto.randomUUID()
  const claims = { userId, jti: id, fam: familyId }
  const token = exp
    ? jwt.sign({ ...claims, exp }, refreshSecret(), { algorithm: 'HS256' })
    : jwt.sign(claims, refreshSecret(), { algorithm: 'HS256', expiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '7d' })
  const { exp: finalExp } = jwt.decode(token)
  await db.refreshToken.create({
    data: { id, familyId, userId, tokenHash: hashToken(token), expiresAt: new Date(finalExp * 1000) },
  })
  return token
}

// Start a new session (login / register). Returns the refresh token.
export async function issueRefreshToken(user) {
  return createToken(prisma, { userId: user.id, familyId: crypto.randomUUID() })
}

async function revokeFamily(familyId, reason) {
  const { count } = await prisma.refreshToken.updateMany({
    where: { familyId, revokedAt: null },
    data: { revokedAt: new Date(), revokeReason: reason },
  })
  return count
}

const fail = (reason) => ({ ok: false, reason })

// Exchange a refresh token for a new one. Returns { ok: true, user, refreshToken } or { ok: false, reason }.
// `reason` is for server-side logging/tests only; routes must answer every failure with the same 401.
export async function rotateRefreshToken(token) {
  if (typeof token !== 'string' || !token || token.length > MAX_TOKEN_LENGTH) return fail('invalid')

  let payload
  try {
    payload = jwt.verify(token, refreshSecret(), { algorithms: ['HS256'] })
  } catch (err) {
    return fail(err?.name === 'TokenExpiredError' ? 'expired' : 'invalid')
  }
  // Tokens without jti/fam/exp (issued before sessions existed) are not tracked, so they cannot be revoked: reject.
  if (
    typeof payload.userId !== 'string' || typeof payload.jti !== 'string' ||
    typeof payload.fam !== 'string' || typeof payload.exp !== 'number'
  ) {
    return fail('legacy-or-malformed')
  }

  const row = await prisma.refreshToken.findUnique({ where: { id: payload.jti } })
  if (
    !row || row.userId !== payload.userId || row.familyId !== payload.fam ||
    !safeEqual(row.tokenHash, hashToken(token))
  ) {
    return fail('unknown')
  }

  const now = new Date()
  if (row.expiresAt <= now) return fail('expired')

  if (row.revokedAt) {
    if (row.revokeReason !== 'rotated') return fail('revoked')
    if (now.getTime() - row.revokedAt.getTime() <= reuseGraceMs()) return fail('rotated-recently')
    await revokeFamily(row.familyId, 'reuse-detected')
    return fail('reuse-detected')
  }

  // Read the user again so role/company changes (or a deleted user) are respected
  const user = await prisma.user.findUnique({ where: { id: row.userId }, include: { company: true } })
  if (!user) {
    await revokeFamily(row.familyId, 'logout')
    return fail('user-missing')
  }

  // Claim the token: only ONE concurrent request can flip revokedAt from null (conditional UPDATE).
  const next = await prisma.$transaction(async (tx) => {
    const claimed = await tx.refreshToken.updateMany({
      where: { id: row.id, revokedAt: null },
      data: { revokedAt: now, revokeReason: 'rotated' },
    })
    if (claimed.count !== 1) return null
    return createToken(tx, { userId: row.userId, familyId: row.familyId, exp: payload.exp })
  })
  if (!next) return fail('rotated-recently')

  return { ok: true, user, refreshToken: next }
}

// Logout: revoke the session (family) the token belongs to. Idempotent. An expired token still revokes
// its session (the signature proves we issued it). Returns the number of rows revoked.
export async function revokeSessionByToken(token) {
  if (typeof token !== 'string' || !token || token.length > MAX_TOKEN_LENGTH) return 0
  let payload
  try {
    payload = jwt.verify(token, refreshSecret(), { algorithms: ['HS256'], ignoreExpiration: true })
  } catch {
    return 0
  }
  if (typeof payload.userId !== 'string' || typeof payload.fam !== 'string') return 0
  const { count } = await prisma.refreshToken.updateMany({
    where: { familyId: payload.fam, userId: payload.userId, revokedAt: null },
    data: { revokedAt: new Date(), revokeReason: 'logout' },
  })
  return count
}

// "Log out everywhere": revoke every session of ONE user.
export async function revokeAllSessionsForUser(userId) {
  const { count } = await prisma.refreshToken.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date(), revokeReason: 'logout-all' },
  })
  return count
}

// Housekeeping: rows are only needed (for replay detection) until the token itself expires.
export async function purgeExpiredRefreshTokens() {
  const { count } = await prisma.refreshToken.deleteMany({ where: { expiresAt: { lt: new Date() } } })
  return count
}
