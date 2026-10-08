// ============================================================================
// 飞书机器人入口（长连接模式）：与 routes/（HTTP+SSE）、mcp/ 并列的第三个渠道
// ----------------------------------------------------------------------------
// 职责：事件订阅 im.message.receive_v1 → open_id 映射内部用户 → runAgent 聚合执行
//       → 互动卡片回复（正文 + 来源）。与 chat.js 的差异：飞书不消费 SSE，
//       攒完 sources + 最终答案后一次性回复。
// 依赖方向：只调内核（agent/acl/store/obs），不触碰领域层；collection 留空走
//       graph 内部 activeCollection() 默认语义，与通用问答一致。
// 开关：FEISHU_ENABLED=true 且 appId/secret 齐全才启动（server.js 调 startFeishuBot）。
// 身份映射：通讯录邮箱/手机号 ↔ users.username 精确匹配；兜底 FEISHU_USER_MAP。
// ============================================================================

import { createHash } from 'node:crypto'
import lark from '@larksuiteoapi/node-sdk'
import { config } from '../config.js'
import { runAgent } from '../agent/graph.js'
import { buildAgentSystem } from '../agent/prompts.js'
import { rootSpan, runInCtx, flushObs } from '../obs/otel.js'
import { insertSession, getSession, insertMsg, getMemory, listAfterSeq, getUserByName } from '../store/pg.js'
import { aclFor } from '../acl.js'
import { answerCacheKey, getAnswer, setAnswer, kbEpoch } from '../rag/answer-cache.js'
import { activeCollection } from '../domain/registry.js'

// 已处理消息去重（飞书事件可能重推；LRU 语义，超上限清一半）
const seenMsg = new Map()
const seen = (id) => {
  if (seenMsg.has(id)) return true
  seenMsg.set(id, 1)
  if (seenMsg.size > 500) for (const k of [...seenMsg.keys()].slice(0, 250)) seenMsg.delete(k)
  return false
}

// 每 chat 串行：同一会话上一条未答完不并发起跑（LLM 成本闸 + 防答案交错）
const busy = new Set()

// 会话 ID：openId+chatId 确定性派生（重启后会话与历史消息自然延续，落库可回放）
const sessionIdFor = (key) => `fs-${createHash('sha1').update(key).digest('hex').slice(0, 24)}`

// open_id → 内部用户（进程缓存 10 分钟；改 FEISHU_USER_MAP/角色无需重启）
const userCache = new Map()
const asUser = (row) => ({ sub: row.id, role: row.role || 'member', dept: row.dept || '' })

async function resolveUser(client, openId, log) {
  const hit = userCache.get(openId)
  if (hit && hit.exp > Date.now()) return hit.u
  let u = null
  // 1) 通讯录邮箱/手机号 ↔ users.username（手机号去 +86 前缀归一比较）
  try {
    const { data } = await client.contact.v3.user.get({
      path: { user_id: openId },
      params: { user_id_type: 'open_id' },
    })
    const p = data?.user ?? {}
    const candidates = [p.email, p.mobile, p.mobile?.replace(/\D/g, '').replace(/^86(?=\d{11}$)/, '')]
      .filter(Boolean)
    for (const key of candidates) {
      const row = await getUserByName(key)
      if (row) { u = asUser(row); break }
    }
    if (!candidates.length) {
      log.warn?.('[feishu] 通讯录未返回 email/mobile：检查 contact:user.email:readonly / contact:user.phone:readonly scope，及该用户是否在应用可用范围内')
    }
  } catch (e) {
    log.warn?.(`[feishu] 通讯录查询失败（检查 contact 权限 scope）: ${e.message}`)
  }
  // 2) 兜底：FEISHU_USER_MAP=openId:username,...
  if (!u) {
    const pair = String(config.feishu.userMap ?? '')
      .split(',').map((s) => s.trim()).find((s) => s.startsWith(`${openId}:`))
    const name = pair?.slice(openId.length + 1)
    if (name) {
      const row = await getUserByName(name)
      if (row) u = asUser(row)
    }
  }
  userCache.set(openId, { u, exp: Date.now() + 600_000 })
  return u
}

// ---- 回复封装：互动卡片（markdown 正文 + 来源）与纯文本（提示/报错）----
const CARD_LIMIT = 9000 // 卡片内容安全上限（官方 32k，留余量）

async function replyCard(client, messageId, answer, sources) {
  const srcLines = sources
    .map((s, i) => `${i + 1}. ${s.filename}${s.title ? ` · ${s.title}` : ''}`)
    .join('\n')
  const md = `${answer}${srcLines ? `\n\n---\n**来源**\n${srcLines}` : ''}`.slice(0, CARD_LIMIT)
  await client.im.v1.message.reply({
    path: { message_id: messageId },
    data: {
      msg_type: 'interactive',
      content: JSON.stringify({
        config: { wide_screen_mode: true },
        elements: [{ tag: 'markdown', content: md }],
      }),
    },
  })
}

async function replyText(client, messageId, text) {
  await client.im.v1.message.reply({
    path: { message_id: messageId },
    data: { msg_type: 'text', content: JSON.stringify({ text }) },
  })
}

// ---- 单轮问答：与 chat.js 同源流水线的聚合版（无 SSE、无压缩摘要；回答缓存跨渠道共享）----
async function runTurn({ client, event, user }) {
  const raw = JSON.parse(event.message.content ?? '{}').text ?? ''
  const question = raw.replace(/@_user_\d+/g, '').replace(/\s+/g, ' ').trim()
  const chatKey = `${event.sender.sender_id.open_id}:${event.message.chat_id}`
  const sessionId = sessionIdFor(chatKey)
  if (!(await getSession(sessionId))) {
    await insertSession(sessionId, `飞书:${event.sender.sender_id.open_id.slice(0, 8)}`, user.sub)
  }

  // sources 合并与 chat.js 同规则：跨轮按 docId:chunkIndex 去重、原位取高分、保首现顺序
  let sources = []
  const emit = (ev, data) => {
    if (ev !== 'sources') return
    const byKey = new Map(sources.map((s) => [`${s.docId}:${s.chunkIndex}`, s]))
    for (const s of data.sources) {
      const k = `${s.docId}:${s.chunkIndex}`
      const prev = byKey.get(k)
      if (!prev) byKey.set(k, s)
      else if (prev.score < s.score) prev.score = s.score
    }
    sources = [...byKey.values()]
  }
  const usageAcc = []

  const root = rootSpan('飞书问答', {
    'langfuse.session.id': sessionId,
    'langfuse.user.id': user.sub,
    'input.value': JSON.stringify({ question }).slice(0, 2000),
  })
  try {
    const boundary = (await getMemory(sessionId))?.summarized_seq ?? 0
    const history = (await listAfterSeq(sessionId, boundary))
      .map((m) => ({ role: m.role, content: m.content }))
    const acl = await aclFor(user)
    // 回答缓存探测：与 chat.js 同键语义（问题+topK+ACL指纹+KB纪元），跨渠道共享缓存；
    // 命中 → 落库 + 卡片回放，省掉检索/评估/LLM 全链路
    let cacheKey = null
    if (config.answerCache.ttlSec > 0) {
      try {
        cacheKey = answerCacheKey({ question, topK: 5, acl, epoch: await kbEpoch(activeCollection()) })
        const cached = await getAnswer(cacheKey)
        if (cached) {
          root.setAttr('langfuse.trace.metadata', JSON.stringify({ cacheHit: true, channel: 'feishu' }))
          await insertMsg(sessionId, 'user', question, null)
          await insertMsg(sessionId, 'assistant', cached.answer,
            JSON.stringify({ sources: cached.sources, steps: [], usage: cached.usage, stopReason: 'cache', channel: 'feishu' }))
          await replyCard(client, event.message.message_id, cached.answer, cached.sources)
          return
        }
      } catch { cacheKey = null } // 缓存层抖动 → 按未命中走主链路
    }
    const result = await runInCtx(root, () =>
      runAgent({
        messages: [
          { role: 'system', content: buildAgentSystem() },
          ...history,
          { role: 'user', content: question },
        ],
        topK: 5,
        signal: new AbortController().signal,
        emit,
        usageAcc,
        acl,
        user, // M20 写工具执行身份（与 chat 通道同语义）
        sessionId,
      })
    )
    const answer =
      [...result.messages].reverse().find((m) => m.role === 'assistant' && m.content)?.content ?? ''
    // usage 汇总（与 chat.js 同规则）；供缓存值与落库 meta 使用
    const usage = usageAcc.reduce(
      (a, u) =>
        u
          ? {
            promptTokens: a.promptTokens + (u.prompt_tokens || 0),
            completionTokens: a.completionTokens + (u.completion_tokens || 0),
            totalTokens: a.totalTokens + (u.total_tokens || 0),
          }
          : a,
      { promptTokens: 0, completionTokens: 0, totalTokens: 0 }
    )

    // 落库：与网页端同会话模型，/api/sessions 可回放（meta 标 channel 便于区分）
    await insertMsg(sessionId, 'user', question, null)
    await insertMsg(sessionId, 'assistant', answer,
      JSON.stringify({ sources, steps: [], usage, stopReason: result.stopReason ?? 'normal', channel: 'feishu' }))
    // 回填缓存（setAnswer 内部拒收空 sources 的兜底直答；成功实答跨渠道共享）
    if (cacheKey) await setAnswer(cacheKey, { answer, sources, usage, rounds: result.stepCount })
    await replyCard(client, event.message.message_id, answer, sources)
  } finally {
    root.end()
    await flushObs()
  }
}

// ---- 启停门面：server.js 调 startFeishuBot / 返回 stop 供优雅退出 ----
export function feishuEnabled() {
  return Boolean(config.feishu.enabled && config.feishu.appId && config.feishu.appSecret)
}

export async function startFeishuBot(log = console) {
  if (!feishuEnabled()) return null
  const client = new lark.Client(
    { appId: config.feishu.appId, appSecret: config.feishu.appSecret },
    { loggerLevel: 'warn' }
  )
  // 群聊 @ 触发判定：启动时取一次 bot open_id（SDK 未封装该端点，走裸 REST；失败则群消息一律忽略）
  let botOpenId = ''
  try {
    const token = await client.tokenManager.getTenantAccessToken()
    const res = await client.httpInstance.request({
      method: 'GET',
      url: `${client.domain}/open-apis/bot/v3/info`,
      headers: { authorization: `Bearer ${token}` },
    })
    const body = res?.data?.bot ?? res?.bot ?? {} // httpInstance 可能解包响应体，两种形状都兼容
    botOpenId = body.open_id ?? ''
    if (!botOpenId) log.warn?.('[feishu] bot info 未返回 open_id，群聊 @ 触发不可用')
  } catch (e) {
    log.warn?.(`[feishu] 获取 bot 信息失败，群聊 @ 触发不可用: ${e.message}`)
  }

  const ws = new lark.WSClient(
    { appId: config.feishu.appId, appSecret: config.feishu.appSecret },
    { loggerLevel: 'warn' }
  )
  await ws.start({
    eventDispatcher: new lark.EventDispatcher({}).register({
      'im.message.receive_v1': async (data) => {
        try {
          const msg = data.message ?? {}
          if (msg.message_type !== 'text') return // v1 只接文本；文件/富文本后续迭代
          if (msg.chat_type === 'group' &&
            !(msg.mentions ?? []).some((m) => m.id?.open_id === botOpenId)) return // 群里必须 @ 机器人
          if (data.sender?.sender_type !== 'user') return // 忽略其他 bot
          if (seen(msg.message_id)) return
          const user = await resolveUser(client, data.sender?.sender_id?.open_id, log)
          if (!user) {
            log.warn?.(`[feishu] 未绑定用户 open_id=${data.sender?.sender_id?.open_id}（可配 FEISHU_USER_MAP 兜底）`)
            await replyText(client, msg.message_id,
              '尚未绑定知识库账号：请让管理员把你的飞书邮箱/手机号设为系统用户名，或在 FEISHU_USER_MAP 配置 open_id 映射。')
            return
          }
          const chatId = msg.chat_id
          if (busy.has(chatId)) {
            await replyText(client, msg.message_id, '上一个问题还在回答中，请稍候…')
            return
          }
          busy.add(chatId)
          try {
            await runTurn({ client, event: data, user })
          } catch (e) {
            log.error(`[feishu] 问答失败: ${e.message}`)
            await replyText(client, msg.message_id, `出错了：${e.message}`).catch(() => { })
          } finally {
            busy.delete(chatId)
          }
        } catch (e) {
          log.error(`[feishu] 事件处理异常: ${e.message}`)
        }
      },
    }),
  })
  log.info('[feishu] 长连接已建立（im.message.receive_v1）')
  return { client, stop: async () => { try { ws.close?.() } catch { } } }
}
