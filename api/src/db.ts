import { PrismaClient } from '../generated/prisma/index.js'

import { createSecretBox, enableWal, gracefulShutdown } from '@feishu-sso/db-kit'

import { env } from './env'

// 数据库地址由 Prisma 直接读 DATABASE_URL：运行时与 prisma CLI 都以 prisma/ 目录
// 解析相对路径，两边才能指向同一个文件。
export const prisma = new PrismaClient({
  log: env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
})

export const secretBox = createSecretBox(env.AUTH_DATA_KEY)

export async function initDb(): Promise<void> {
  if (env.DATABASE_URL.startsWith('file:')) await enableWal(prisma)
  gracefulShutdown(prisma)
}
