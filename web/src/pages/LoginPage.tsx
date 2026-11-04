import { AlertCircle, Loader2 } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'

import { buildAuthorizeUrl, isLarkWebview } from '../authorize-url'
import { brandName, detectLang, translate, type MessageKey, type Provider } from '../i18n'
import { fetchSiteInfo } from '../site-info'

/**
 * 登录页：点「使用飞书登录」跳到 /auth/api/feishu/authorize，在飞书内置浏览器里自动跳转。
 * 访问路径为 /auth/login（本地开发为 http://localhost:5020/auth/login）。
 */
export function LoginPage() {
  const { error, returnTo, isLark, lang } = useMemo(() => {
    const p = new URLSearchParams(window.location.search)
    return {
      error: p.get('error'),
      returnTo: p.get('return_to') ?? '/',
      isLark: isLarkWebview(navigator.userAgent),
      lang: detectLang(window.location.search, navigator.languages ?? [navigator.language]),
    }
  }, [])

  // 站点名与飞书版本由服务端配置；站点名取到之前留空，避免先闪一下默认名再换掉。
  const [siteName, setSiteName] = useState<string | null>(null)
  const [provider, setProvider] = useState<Provider>('feishu')
  const brand = brandName(lang, provider)
  const t = (key: MessageKey, params?: Record<string, string>) => translate(lang, key, { brand, ...params })

  useEffect(() => {
    document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en'
    document.title = translate(lang, 'login.docTitle')
    void fetchSiteInfo(window.location.origin).then((info) => {
      const name = info.name ?? translate(lang, 'site.defaultName')
      setSiteName(name)
      setProvider(info.provider)
      document.title = translate(lang, 'login.docTitleWithSite', { name })
    })
  }, [lang])

  const [submitting, setSubmitting] = useState(false)
  // Set when the Feishu-webview one-tap auto-redirect detects it's bouncing in
  // a loop (the session isn't sticking) — we then STOP auto-redirecting and
  // show the manual button + a hint instead of an infinite redirect storm.
  const [loopDetected, setLoopDetected] = useState(false)

  const authorizeUrl = buildAuthorizeUrl(window.location.origin, returnTo)

  const onLogin = () => {
    setSubmitting(true)
    window.location.assign(authorizeUrl)
  }

  // Auto-redirect inside the Feishu app webview — UX expects a "one tap" flow.
  // Loop breaker: if we auto-redirected moments ago and we're BACK on the login
  // page, the session isn't establishing (cookie not recognized) — redirecting
  // again would spin forever. Detect the quick re-entry, stop auto-redirecting,
  // and fall back to the manual button + a hint so the user isn't trapped.
  useEffect(() => {
    if (!isLark || error) return
    const KEY = 'sso_login_autoredirect'
    const MIN_GAP_MS = 10_000
    const MAX_TRIES = 2 // allow a couple of quick auto-redirects before declaring a loop
    let at = 0
    let n = 0
    try {
      const raw = JSON.parse(sessionStorage.getItem(KEY) || '{}')
      at = Number(raw.at) || 0
      n = Number(raw.n) || 0
    } catch { /* ignore */ }
    const now = Date.now()
    // A gap longer than MIN_GAP_MS means the previous redirect resolved fine and
    // this is a fresh attempt — reset the counter so a normal re-login (or a
    // quick legitimate round-trip back to /login) isn't mistaken for a loop.
    if (!at || now - at > MIN_GAP_MS) n = 0
    if (n >= MAX_TRIES) {
      setLoopDetected(true)
      return
    }
    try { sessionStorage.setItem(KEY, JSON.stringify({ at: now, n: n + 1 })) } catch { /* ignore */ }
    setSubmitting(true)
    window.location.replace(authorizeUrl)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <main className="min-h-screen flex items-center justify-center px-6 py-12">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-14 h-14 rounded-xl bg-accent shadow-md mb-4">
            <span className="text-2xl font-bold text-accent-fg">{siteName?.charAt(0) ?? ''}</span>
          </div>
          <h1 className="text-2xl font-bold text-fg min-h-8">{siteName}</h1>
          <p className="text-sm text-fg-muted mt-1">{t('login.subtitle')}</p>
        </div>

        <div className="bg-elevated rounded-xl shadow-lg border border-line p-6">
          {error && (
            <div className="mb-4 flex items-start gap-2 p-3 bg-danger-bg border border-danger-line rounded-lg text-sm text-danger-fg">
              <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
              <div className="min-w-0">
                <p className="font-semibold">{t('login.failed')}</p>
                <p className="text-xs mt-0.5 break-words opacity-80">{errorText(error, t)}</p>
              </div>
            </div>
          )}

          {loopDetected && !error && (
            <div className="mb-4 flex items-start gap-2 p-3 bg-warning-bg border border-warning-line rounded-lg text-sm text-warning-fg">
              <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
              <div className="min-w-0">
                <p className="font-semibold">{t('login.loopTitle')}</p>
                <p className="text-xs mt-0.5 break-words opacity-80">{t('login.loopBody')}</p>
              </div>
            </div>
          )}

          <button
            onClick={onLogin}
            disabled={submitting}
            // 禁用态用 opacity 而不是换成灰色:换色要再挑一个「禁用灰」,那又是一个
            // 产品私有色;透明度由 accent 导出,三套皮肤下都成立。
            className="w-full py-3 px-4 rounded-lg bg-accent hover:bg-accent/90 disabled:opacity-50 text-accent-fg font-semibold text-sm shadow-sm transition-all inline-flex items-center justify-center gap-2"
          >
            {submitting ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                {t('login.redirecting')}
              </>
            ) : (
              <>
                <FeishuMark className="w-5 h-5" />
                {t('login.button')}
              </>
            )}
          </button>

          <p className="text-xs text-fg-faint mt-6 leading-relaxed">{t('login.consent')}</p>
        </div>

        <p className="text-center text-xs text-fg-faint mt-6">
          {siteName ? `${siteName} · ` : ''}
          {t('login.poweredBy')}
        </p>
      </div>
    </main>
  )
}

/** 登录失败时 api 回跳带的错误码 → 当前语言的说明；不认识的错误码原样显示。 */
const ERROR_KEYS = new Set<string>(['provider_error', 'missing_params', 'invalid_or_expired_state', 'exchange_failed'])
function errorText(code: string, t: (key: MessageKey) => string): string {
  return ERROR_KEYS.has(code) ? t(`error.${code}` as MessageKey) : code
}

function FeishuMark({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M5 6h9a5 5 0 0 1 0 10H7l-2 3V6z" fill="currentColor" opacity="0.95" />
    </svg>
  )
}
