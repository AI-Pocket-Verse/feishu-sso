import { LoginPage } from './pages/LoginPage'

/**
 * 登录服务的前端只有一个页面：/auth/ 与 /auth/login 都显示登录页，
 * 其余路径由 api（/auth/api/*）处理。
 */
export function App() {
  return <LoginPage />
}
