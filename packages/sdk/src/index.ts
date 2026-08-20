// ============ 内核 ============
export * from '@zhuxing/harness-kernel'

// ============ 模型适配 ============
export * from '@zhuxing/harness-llm'

// ============ 沙箱 ============
export * from '@zhuxing/harness-sandbox'

// ============ 会话 ============
export * from '@zhuxing/harness-session'

// ============ 工具 ============
export * from '@zhuxing/harness-tools'

// ============ Agent 循环 ============
export * from '@zhuxing/harness-agent'

import { OpenAICompatibleProvider } from '@zhuxing/harness-llm'
import type { OpenAICompatibleOptions } from '@zhuxing/harness-llm'
import type { ChatProvider } from '@zhuxing/harness-llm'
import type { ToolDefinition } from '@zhuxing/harness-tools'

/** 定义工具（类型安全的 DSL 入口）。 */
export function defineTool(def: ToolDefinition): ToolDefinition {
  return def
}

/** 便捷构造 OpenAI 兼容模型适配器。 */
export function createOpenAIProvider(options: OpenAICompatibleOptions): ChatProvider {
  return new OpenAICompatibleProvider(options)
}
