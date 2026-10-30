import prisma from '../prisma.js'
import { requireRole } from './auth.js'

// Single source of truth for "which role may do what". Roles are the Prisma `Role` enum (ADMIN, MEMBER).
//
// Anything NOT listed here cannot be protected with requirePermission(): asking for an unknown
// permission throws when the route is defined, so a typo fails at start-up instead of silently
// leaving a route open (or closed to everyone).
//
// Every authenticated company member (no entry needed, only requireAuth): upload a document, list/read
// documents, search, ask questions, read the knowledge graph, list teammates.
export const PERMISSIONS = Object.freeze({
  // Destructive or expensive operations on company data
  'document:delete': ['ADMIN'],
  'document:reindex': ['ADMIN'], // rebuilds the vector index of a document
  'graph:reprocess': ['ADMIN'], // re-runs NLP + knowledge-graph ingestion of a document

  // People and roles
  'users:manage': ['ADMIN'], // change a teammate's role, remove a teammate

  // RESERVED: the product has no routes for these yet (INTEGRATION.md: meeting transcription and GitHub
  // ingestion are "not done"). They are defined now so the first route that is added is admin-only by
  // default: use requirePermission('integration:manage'), do not invent a new rule.
  'company:configure': ['ADMIN'],
  'integration:manage': ['ADMIN'], // meeting / GitHub / any third-party integration
  'credentials:manage': ['ADMIN'], // API keys, tokens, webhook secrets
})

const NOT_ALLOWED = { success: false, message: 'You do not have permission to do this' }

// Use after requireAuth. Two independent checks:
//   1. the role in the signed JWT must be allowed (cheap, rejects members without touching the database);
//   2. the role and company are read again from PostgreSQL, so a demoted or removed user loses these
//      powers immediately instead of when the 15-minute access token expires. The JWT is never the
//      only thing a privileged action depends on.
// It only ever ADDS restrictions on top of requireRole. Resource ownership (the document / user belongs to
// req.user.companyId) must still be checked by the route itself, because a role says nothing about tenancy.
export function requirePermission(permission) {
  const roles = PERMISSIONS[permission]
  if (!roles) throw new Error(`Unknown permission "${permission}" (add it to PERMISSIONS in middleware/permissions.js)`)
  const jwtGate = requireRole(...roles)

  return (req, res, next) => {
    jwtGate(req, res, async () => {
      try {
        const current = await prisma.user.findUnique({
          where: { id: req.user.userId },
          select: { id: true, companyId: true, role: true },
        })
        if (!current) {
          return res.status(401).json({ success: false, message: 'Authentication required' })
        }
        // Role or company in the token no longer matches the database -> treat the token as stale.
        if (current.companyId !== req.user.companyId || !roles.includes(current.role)) {
          return res.status(403).json(NOT_ALLOWED)
        }
        // From here on the database value is the one to trust.
        req.user = { ...req.user, role: current.role }
        next()
      } catch (err) {
        console.error('Permission check error:', err)
        res.status(500).json({ success: false, message: 'Something went wrong' })
      }
    })
  }
}
