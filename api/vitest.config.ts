import { defineConfig } from 'vitest/config'

// vitest 4 的默认排除只剩 node_modules 与 .git：tsc 构建会把 *.test.ts 编进 dist/，不排除就会重复跑旧的编译产物。
export default defineConfig({
  test: {
    exclude: ['**/node_modules/**', '**/.git/**', 'dist/**'],
  },
})
