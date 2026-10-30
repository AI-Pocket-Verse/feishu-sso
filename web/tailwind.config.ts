import type { Config } from 'tailwindcss'
// @ts-expect-error -- shared preset is plain CJS, no types needed
import preset from '@feishu-sso/tailwind-preset'

/**
 * 这里不加任何颜色：全走共享语义 token（bg-accent、text-fg…），
 * 定义在 packages/design-tokens/skins/*.css。
 */
export default {
  presets: [preset],
  content: ['./index.html', './src/**/*.{ts,tsx}'],
} satisfies Config
