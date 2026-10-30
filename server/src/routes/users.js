import { Router } from 'express'
import prisma from '../prisma.js'
import { requireAuth } from '../middleware/auth.js'
import { requirePermission } from '../middleware/permissions.js'

const router = Router()

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Keep in sync with `enum Role` in prisma/schema.prisma. Anything else in a request is rejected.
const ROLES = ['ADMIN', 'MEMBER']

// Never send the password hash, and never the email of a teammate: names and roles are enough for the UI.
const memberSelect = { id: true, name: true, role: true, createdAt: true }

// ---------- GET /api/users ----------
// Every member of the caller's company (and only that company). Any authenticated member may list teammates.
router.get('/', requireAuth, async (req, res) => {
  try {
    const users = await prisma.user.findMany({
      where: { companyId: req.user.companyId },
      select: memberSelect,
      orderBy: { createdAt: 'asc' },
    })
    res.json({ success: true, users })
  } catch (err) {
    console.error('List users error:', err)
    res.status(500).json({ success: false, message: 'Something went wrong' })
  }
})

// ---------- PATCH /api/users/:id/role ----------
// Body: { "role": "ADMIN" | "MEMBER" }. ADMIN only (users:manage).
// - the target is found by id AND the caller's company, so another company's user is "not found" (404);
// - only the role field is ever written; no other property of the body is read;
// - the last administrator of a company cannot be demoted (the company would be left unmanageable).
// Roles are changed ONLY here: registration, login and the (future) profile update never accept a role.
router.patch('/:id/role', requireAuth, requirePermission('users:manage'), async (req, res) => {
  try {
    if (!UUID_REGEX.test(req.params.id)) {
      return res.status(400).json({ success: false, message: 'Invalid user ID' })
    }
    const role = req.body?.role
    if (typeof role !== 'string' || !ROLES.includes(role)) {
      return res.status(400).json({ success: false, message: `role must be one of: ${ROLES.join(', ')}` })
    }
    const companyId = req.user.companyId

    // Serializable: two admins demoting each other at the same moment cannot leave the company without an admin.
    const outcome = await prisma.$transaction(
      async (tx) => {
        const target = await tx.user.findFirst({ where: { id: req.params.id, companyId }, select: memberSelect })
        if (!target) return { status: 404, message: 'User not found' }
        if (target.role === role) return { status: 200, user: target }

        if (target.role === 'ADMIN' && role !== 'ADMIN') {
          const admins = await tx.user.count({ where: { companyId, role: 'ADMIN' } })
          if (admins <= 1) return { status: 409, message: 'A company must keep at least one administrator' }
        }
        const result = await tx.user.updateMany({ where: { id: target.id, companyId }, data: { role } })
        if (result.count !== 1) return { status: 404, message: 'User not found' }
        return { status: 200, user: { ...target, role } }
      },
      { isolationLevel: 'Serializable' }
    )

    if (outcome.status !== 200) return res.status(outcome.status).json({ success: false, message: outcome.message })
    res.json({ success: true, user: outcome.user })
  } catch (err) {
    if (err.code === 'P2034') {
      return res.status(409).json({ success: false, message: 'The company was changed at the same time. Please try again.' })
    }
    console.error('Change role error:', err)
    res.status(500).json({ success: false, message: 'Something went wrong' })
  }
})

// ---------- DELETE /api/users/:id ----------
// Removes a teammate from the company. ADMIN only (users:manage). You cannot remove yourself (that also
// guarantees the last administrator is never removed). Their documents stay (uploadedBy becomes null).
router.delete('/:id', requireAuth, requirePermission('users:manage'), async (req, res) => {
  try {
    if (!UUID_REGEX.test(req.params.id)) {
      return res.status(400).json({ success: false, message: 'Invalid user ID' })
    }
    if (req.params.id === req.user.userId) {
      return res.status(400).json({ success: false, message: 'You cannot remove yourself' })
    }
    // id AND company in the same condition: another company's user is "not found"
    const result = await prisma.user.deleteMany({ where: { id: req.params.id, companyId: req.user.companyId } })
    if (result.count === 0) {
      return res.status(404).json({ success: false, message: 'User not found' })
    }
    res.json({ success: true, message: 'User removed' })
  } catch (err) {
    console.error('Remove user error:', err)
    res.status(500).json({ success: false, message: 'Something went wrong' })
  }
})

export default router
