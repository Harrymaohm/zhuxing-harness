/** token-plan（阿里云百炼聚合 API）配置与 DashScope 原生协议适配：生图 / 视频 / 语音合成。 */
import { randomUUID } from 'node:crypto'
import WebSocket from 'ws'
import type { ModelConfigEntry } from '@zhuxing/harness-model-router'

/** 生图模型配置。 */
export interface ImageModelOptions {
  model: string
  baseUrl?: string
  apiKey?: string
  size?: string
  /**
   * 协议模式：
   * - 'openai'：OpenAI 兼容 /images/generations（默认，兼容 dall-e-3 / deepseek 等）。
   * - 'dashscope'：阿里云百炼 DashScope 原生接口（qwen-image 系列，不支持 OpenAI 兼容）。
   */
  mode?: 'openai' | 'dashscope'
}

/** token-plan 专用域名（阿里云百炼聚合 API）。 */
export const DEFAULT_TOKEN_PLAN_ORIGIN = 'https://token-plan.cn-beijing.maas.aliyuncs.com'

/**
 * token-plan 配置：一个阿里云 token-plan API Key 下挂多类模型（文本生成 / 生图 / 语音 / Realtime-Chatting）。
 * 单独配置，但其中的文本子模型会注册进模型路由，供主模型通过 pick_model 自行选调。
 */
export interface TokenPlanOptions {
  /** token-plan 专用 API Key。 */
  apiKey?: string
  /** 专用域名（缺省 token-plan.cn-beijing.maas.aliyuncs.com）。 */
  baseUrl?: string
  /** 文本生成子模型（注册进模型路由，可由主模型 pick_model 选调）。 */
  textModels?: ModelConfigEntry[]
  /** 生图模型（首个用于 generate_image 工具，DashScope 原生模式）。 */
  imageModels?: Array<{ model: string; size?: string }>
  /** 视频生成模型（首个用于 generate_video 工具，DashScope 异步任务 + 轮询）。 */
  videoModels?: Array<{ model: string; label?: string }>
  /** 语音合成模型（首个用于 text_to_speech 工具，DashScope WebSocket 协议）。 */
  voiceModels?: Array<{ model: string; label?: string }>
  /** Realtime-Chatting 模型（配置占位，暂未接入运行时工具）。 */
  realtimeModels?: Array<{ model: string; label?: string }>
}

/** 提取 DashScope 原生接口域名（兼容用户填 compatible-mode/v1 或根域名，去掉路径前缀）。 */
export function dashScopeOrigin(baseUrl: string): string {
  try {
    return new URL(baseUrl).origin
  } catch {
    return baseUrl.replace(/\/+$/, '')
  }
}

/** token-plan 的 OpenAI 兼容文本端点基址：归一化为 `${origin}/compatible-mode/v1`。 */
export function tokenPlanChatBase(baseUrl: string): string {
  try {
    return `${new URL(baseUrl).origin}/compatible-mode/v1`
  } catch {
    return baseUrl.replace(/\/+$/, '')
  }
}

/** token-plan 语音合成的 WebSocket 地址：统一为 `wss://<host>/api-ws/v1/inference`。 */
export function tokenPlanWsUrl(baseUrl: string): string {
  try {
    return `wss://${new URL(baseUrl).host}/api-ws/v1/inference`
  } catch {
    return baseUrl.replace(/^http/, 'ws').replace(/\/+$/, '')
  }
}

/** DashScope 语音合成 WebSocket 客户端（run-task → continue-task → 收音频 → finish-task → task-finished）。 */
export function dashScopeTts(params: {
  url: string
  apiKey?: string
  model: string
  voice: string
  format: string
  text: string
}): Promise<Buffer> {
  return new Promise((resolveResult, reject) => {
    const ws = new WebSocket(params.url, {
      headers: { Authorization: `Bearer ${params.apiKey ?? ''}` },
    })
    const taskId = randomUUID()
    const chunks: Buffer[] = []
    let sentText = false
    let settled = false
    const timeout = setTimeout(() => fail(new Error('语音合成超时')), 120_000)

    function fail(err: Error): void {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      try {
        ws.close()
      } catch {
        /* ignore */
      }
      reject(err)
    }
    function done(buf: Buffer): void {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      try {
        ws.close()
      } catch {
        /* ignore */
      }
      resolveResult(buf)
    }

    ws.on('open', () => {
      ws.send(
        JSON.stringify({
          header: { action: 'run-task', task_id: taskId, streaming: 'duplex' },
          payload: {
            task_group: 'audio',
            task: 'tts',
            function: 'SpeechSynthesizer',
            model: params.model,
            parameters: { text_type: 'PlainText', voice: params.voice, format: params.format },
            input: {},
          },
        }),
      )
    })

    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        const buf = Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer)
        chunks.push(buf)
        return
      }
      const raw = data.toString('utf-8')
      let event: { header?: { event?: string; error_message?: string } }
      try {
        event = JSON.parse(raw) as { header?: { event?: string; error_message?: string } }
      } catch {
        return
      }
      const evt = event?.header?.event
      if (evt === 'task-started' && !sentText) {
        // 文本已一次性提交：先 continue-task 缓存文本，再 finish-task 强制合成并流式返回全部音频
        sentText = true
        ws.send(
          JSON.stringify({
            header: { action: 'continue-task', task_id: taskId, streaming: 'duplex' },
            payload: { input: { text: params.text } },
          }),
        )
        ws.send(
          JSON.stringify({
            header: { action: 'finish-task', task_id: taskId, streaming: 'duplex' },
            payload: { input: {} },
          }),
        )
      } else if (evt === 'task-finished') {
        done(Buffer.concat(chunks))
      } else if (evt === 'task-failed') {
        fail(new Error(event?.header?.error_message ?? '语音合成任务失败'))
      }
    })

    ws.on('error', (err) => fail(err instanceof Error ? err : new Error(String(err))))
    ws.on('close', () => {
      if (settled) return
      if (chunks.length) done(Buffer.concat(chunks))
      else fail(new Error('语音合成连接关闭'))
    })
  })
}
