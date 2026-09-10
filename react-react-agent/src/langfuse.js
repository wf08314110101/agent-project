import { Langfuse } from 'langfuse'

/**
 * Langfuse 观测入口：配置了 Key 则初始化官方 SDK 单例，未配置则给全空转 stub，
 * 让 agent.js 零分支接入。SDK 自带批量上报与重试。
 * ⚠️ VITE_ 变量会打进前端产物（Secret Key 暴露到浏览器），仅限本地学习，
 *    生产应在后端代理上报。
 */
const publicKey = import.meta.env.VITE_LANGFUSE_PUBLIC_KEY
const secretKey = import.meta.env.VITE_LANGFUSE_SECRET_KEY
export const langfuseEnabled = !!(publicKey && secretKey)

const noopObs = () => ({ id: '', end: () => { } })
const noopTrace = { id: '', span: noopObs, generation: noopObs, update: () => { } }

export const lf = langfuseEnabled
  ? new Langfuse({
    publicKey,
    secretKey,
    baseUrl: import.meta.env.VITE_LANGFUSE_HOST ?? 'https://cloud.langfuse.com',
  })
  : {
    trace: () => noopTrace,
    flushAsync: async () => { },
  }
