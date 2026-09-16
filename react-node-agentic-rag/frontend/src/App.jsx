import { useEffect, useState } from 'react'
import ChatTab from './components/ChatTab.jsx'
import DocsTab from './components/DocsTab.jsx'
import Login from './components/Login.jsx'
import { getToken, setToken, setOnUnauthorized } from './api.js'

export default function App() {
  // 登录态：localStorage有 token 即视为已登录（token 过期由 api 层 401 统一兜底）
  const [user, setUser] = useState(() => (getToken() ? localStorage.getItem('agr_user') || '已登录' : null))
  const [tab, setTab] = useState('chat')

  useEffect(() => {
    // api 层遇 401 会清 token 并回调这里 → 切回登录页
    setOnUnauthorized(() => setUser(null))
  }, [])

  function handleLogin(name) {
    localStorage.setItem('agr_user', name)
    setUser(name)
  }

  function logout() {
    setToken(null)
    localStorage.removeItem('agr_user')
    setUser(null)
  }

  if (!user) return <Login onLogin={handleLogin} />

  return (
    <div className="app">
      <header className="app-header">
        <h1>Agentic RAG</h1>
        <nav>
          <button className={tab === 'chat' ? 'on' : ''} onClick={() => setTab('chat')}>对话</button>
          <button className={tab === 'docs' ? 'on' : ''} onClick={() => setTab('docs')}>文档</button>
        </nav>
        <span className="user-box">
          {user}
          <button className="logout-btn" onClick={logout}>退出</button>
        </span>
      </header>
      <main>{tab === 'chat' ? <ChatTab /> : <DocsTab />}</main>
    </div>
  )
}
