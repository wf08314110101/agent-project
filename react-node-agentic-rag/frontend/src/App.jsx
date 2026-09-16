import { useEffect, useState } from 'react'
import ChatTab from './components/ChatTab.jsx'
import DocsTab from './components/DocsTab.jsx'
import Login from './components/Login.jsx'
import { getToken, setToken, setOnUnauthorized } from './api.js'

export default function App() {
  // 登录态：localStorage有 token 即视为已登录（token 过期由 api 层 401 统一兜底）
  // user = { username, role, dept }（M10 RBAC：role/dept 用于前端 UI 显隐，判定以后端为准）
  const [user, setUser] = useState(() => {
    if (!getToken()) return null
    try { return JSON.parse(localStorage.getItem('agr_user')) } catch { return localStorage.getItem('agr_user') || '已登录' }
  })
  const [tab, setTab] = useState('chat')
  // 指定文档问答：DocsTab「提问」→ 记录目标文档并切到对话 Tab，ChatTab 挂检索范围徽标
  const [askDoc, setAskDoc] = useState(null)

  useEffect(() => {
    // api 层遇 401 会清 token 并回调这里 → 切回登录页
    setOnUnauthorized(() => setUser(null))
  }, [])

  function handleLogin(u) {
    localStorage.setItem('agr_user', JSON.stringify(u))
    setUser(u)
  }

  function logout() {
    setToken(null)
    localStorage.removeItem('agr_user')
    setUser(null)
  }

  if (!user) return <Login onLogin={handleLogin} />

  const isAdmin = user?.role === 'admin'
  return (
    <div className="app">
      <header className="app-header">
        <h1>Agentic RAG</h1>
        <nav>
          <button className={tab === 'chat' ? 'on' : ''} onClick={() => setTab('chat')}>对话</button>
          <button className={tab === 'docs' ? 'on' : ''} onClick={() => setTab('docs')}>文档</button>
        </nav>
        <span className="user-box">
          {user?.username ?? user}
          {user?.dept && <span className="user-dept">{user.dept}</span>}
          {isAdmin && <span className="user-role">admin</span>}
          <button className="logout-btn" onClick={logout}>退出</button>
        </span>
      </header>
      <main>
        {tab === 'chat' ? (
          <ChatTab askDoc={askDoc} onClearAsk={() => setAskDoc(null)} />
        ) : (
          <DocsTab user={user} onAsk={(doc) => { setAskDoc(doc); setTab('chat') }} />
        )}
      </main>
    </div>
  )
}
