/**
 * 大模型厂商预设配置
 *
 * 三步启动法的第 1、2 步数据都来自这里：选厂商 → 选模型 → 填 Key。
 *
 * ⚠️ 模型名变化很快（DeepSeek 的 deepseek-chat / deepseek-reasoner 已于 2026-07-24 停用，
 *    Kimi 的 moonshot-v1-* 也已停止新用户开放）。清单最后核对时间：2026-09。
 *    以厂商控制台的「模型列表」为准，过期了直接改这个文件即可。
 */

/** 自定义 / 兼容网关的 id */
export const CUSTOM_PROVIDER_ID = 'custom';

export const PROVIDERS = [
  {
    id: 'openai',
    name: 'OpenAI',
    baseURL: 'https://api.openai.com/v1',
    models: ['gpt-5', 'gpt-5-mini', 'gpt-4.1', 'gpt-4.1-mini', 'gpt-4o', 'gpt-4o-mini', 'o3', 'o4-mini'],
    defaultModel: 'gpt-4o-mini',
    keyUrl: 'https://platform.openai.com/api-keys',
    note: '海外直连，需自备网络环境',
  },
  {
    id: 'deepseek',
    name: 'DeepSeek 深度求索',
    baseURL: 'https://api.deepseek.com/v1',
    models: ['deepseek-v4-flash', 'deepseek-v4-pro', 'deepseek-v4-flash-vision-exp'],
    defaultModel: 'deepseek-v4-flash',
    keyUrl: 'https://platform.deepseek.com/api_keys',
    note: '旧模型名 deepseek-chat / deepseek-reasoner 已停用，别再填',
  },
  {
    id: 'moonshot',
    name: 'Moonshot / Kimi 月之暗面',
    baseURL: 'https://api.moonshot.cn/v1',
    models: ['kimi-k3', 'kimi-k2.7-code', 'kimi-k2.7-code-highspeed', 'kimi-k2.6'],
    defaultModel: 'kimi-k3',
    keyUrl: 'https://platform.moonshot.cn/console/api-keys',
    note: 'moonshot-v1-* / kimi-k2.5 已停止新用户开放',
  },
  {
    id: 'zhipu',
    name: '智谱 GLM',
    baseURL: 'https://open.bigmodel.cn/api/paas/v4',
    models: ['glm-4.6', 'glm-4.5', 'glm-4.5-air', 'glm-4.5-flash', 'glm-4-plus'],
    defaultModel: 'glm-4.6',
    keyUrl: 'https://open.bigmodel.cn/usercenter/apikeys',
    note: '',
  },
  {
    id: 'qwen',
    name: '通义千问（阿里云百炼）',
    baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    models: [
      'qwen3.8-max',
      'qwen3.7-plus',
      'qwen3.8-flash',
      'qwen-plus',
      'qwen-turbo',
      'qwen-long',
      'qwq-plus',
    ],
    defaultModel: 'qwen-plus',
    keyUrl: 'https://bailian.console.aliyun.com/?tab=model#/api-key',
    note: '国际站换成 https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
  },
  {
    id: 'siliconflow',
    name: '硅基流动 SiliconFlow',
    baseURL: 'https://api.siliconflow.cn/v1',
    models: [
      'Qwen/Qwen3-8B',
      'Qwen/Qwen3-32B',
      'deepseek-ai/DeepSeek-V3',
      'moonshotai/Kimi-K2-Instruct',
    ],
    defaultModel: 'Qwen/Qwen3-8B',
    keyUrl: 'https://cloud.siliconflow.cn/account/ak',
    note: '模型名带厂商前缀，从控制台复制最保险',
  },
  {
    id: 'volcengine',
    name: '火山方舟（豆包）',
    baseURL: 'https://ark.cn-beijing.volces.com/api/v3',
    models: [],
    defaultModel: '',
    modelPlaceholder: 'ep-2026xxxx-xxxxx',
    keyUrl: 'https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey',
    note: '模型名填控制台创建的「接入点 ID」，形如 ep-2026xxxx-xxxxx',
  },
  {
    id: 'ollama',
    name: 'Ollama 本地',
    baseURL: 'http://localhost:11434/v1',
    models: ['qwen3', 'llama3.2', 'deepseek-r1', 'glm4'],
    defaultModel: 'qwen3',
    keyRequired: false,
    keyUrl: '',
    note: '本地运行，无需 Key；先执行 ollama serve 并 pull 好模型',
  },
  {
    id: CUSTOM_PROVIDER_ID,
    name: '自定义 / 兼容网关（OneAPI、NewAPI、vLLM…）',
    baseURL: '',
    models: [],
    defaultModel: '',
    custom: true,
    keyUrl: '',
    note: '手动填 baseURL 和模型名，例如 http://localhost:8787/v1',
  },
];

/** 按 id 取厂商，找不到返回自定义项 */
export function getProvider(id) {
  return PROVIDERS.find((p) => p.id === id) || getProvider(CUSTOM_PROVIDER_ID);
}

/** 是否需要填写 API Key（仅 Ollama 等本地服务声明 keyRequired: false） */
export function isKeyRequired(provider) {
  return provider.keyRequired !== false;
}

/**
 * 根据 baseURL 反查厂商（读 .env 时用它把已有配置映射回厂商）。
 * @param {string} baseURL
 */
export function findProviderByBaseURL(baseURL) {
  const normalize = (u) => String(u || '').replace(/\/+$/, '').toLowerCase();
  const target = normalize(baseURL);
  return PROVIDERS.find((p) => p.baseURL && normalize(p.baseURL) === target) || null;
}
