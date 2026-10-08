import { PrismaClient } from '@prisma/client'

// One shared Prisma client for the whole server
const prisma = new PrismaClient()

export default prisma
