import { useState } from 'react'
import ChatTab from './components/ChatTab.jsx'
import DocsTab from './components/DocsTab.jsx'

export default function App() {
  const [tab, setTab] = useState('chat')

  return (
    <div className="app">
      <header className="app-header">
        <h1>Agentic RAG</h1>
        <nav>
          <button className={tab === 'chat' ? 'on' : ''} onClick={() => setTab('chat')}>对话</button>
          <button className={tab === 'docs' ? 'on' : ''} onClick={() => setTab('docs')}>文档</button>
        </nav>
      </header>
      <main>{tab === 'chat' ? <ChatTab /> : <DocsTab />}</main>
    </div>
  )
}
