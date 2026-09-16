import { useState } from 'react'
import { login } from '../api.js'

// 登录页：无 token 时 App 整页渲染本组件；成功回调 onLogin(username)
export default function Login({ onLogin }) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(e) {
    e.preventDefault()
    if (!username.trim() || !password) return setErr('请输入用户名和密码')
    setBusy(true)
    setErr('')
    try {
      const name = await login(username.trim(), password)
      onLogin(name)
    } catch (ex) {
      setErr(ex.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="login-mask">
      <form className="login-card" onSubmit={submit}>
        <h1>Agentic RAG</h1>
        <p className="login-hint">请登录以继续</p>
        <input
          className="login-input"
          placeholder="用户名"
          autoComplete="username"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
        />
        <input
          className="login-input"
          type="password"
          placeholder="密码"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        {err && <div className="login-err">{err}</div>}
        <button className="login-btn" disabled={busy}>{busy ? '登录中…' : '登录'}</button>
      </form>
    </div>
  )
}
