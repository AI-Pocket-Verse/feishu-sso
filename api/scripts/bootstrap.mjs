/**
 * 首次运行：api/.env.example → api/.env.dev（已存在则不覆盖），
 * 并在 AUTH_DATA_KEY 为空时写入一个随机生成的 32 字节密钥。
 * 由根目录的 `pnpm bootstrap` 调用，之后再建库。
 */
import { randomBytes } from 'node:crypto'
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const dir = fileURLToPath(new URL('..', import.meta.url))
const target = `${dir}.env.dev`

if (!existsSync(target)) {
  copyFileSync(`${dir}.env.example`, target)
  console.log('created api/.env.dev from api/.env.example')
}

const text = readFileSync(target, 'utf8')
if (/^AUTH_DATA_KEY=\s*$/m.test(text)) {
  const key = randomBytes(32).toString('base64')
  writeFileSync(target, text.replace(/^AUTH_DATA_KEY=\s*$/m, `AUTH_DATA_KEY=${key}`))
  console.log('generated AUTH_DATA_KEY in api/.env.dev')
}
