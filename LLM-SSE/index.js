export { chatStream, chat, createClient, LLMError } from './src/llm-client.js';
export { ChatSession } from './src/chat-session.js';
export { createSSEDecoder, iterateSSE, createSSETransformStream } from './src/sse-parser.js';
export { loadEnvIfExists, formatDuration, formatSpeed } from './src/utils.js';
export {
  PROVIDERS,
  getProvider,
  findProviderByBaseURL,
  isKeyRequired,
  CUSTOM_PROVIDER_ID,
} from './src/providers.js';
