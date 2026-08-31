import { exec } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { resolve, join } from 'node:path'
import WebSocket from 'ws'
import type { PluginDefinition } from '@zhuxing/harness-kernel'
import type { PermissionLevel } from '@zhuxing/harness-sandbox'
import { createSandbox } from '@zhuxing/harness-sandbox'
import type { SessionService } from '@zhuxing/harness-session'
import { DefaultSessionService, FileSessionStore, MemorySessionStore } from '@zhuxing/harness-session'
import { OpenAICompatibleProvider } from '@zhuxing/harness-llm'
import type { ChatProvider } from '@zhuxing/harness-llm'
import { ToolRegistryImpl } from '@zhuxing/harness-tools'
import type { ToolRegistry } from '@zhuxing/harness-tools'
import type { AgentOptions } from '@zhuxing/harness-agent'
import {
  ModelMonitorImpl,
  ModelOrchestratorImpl,
  ModelRegistryImpl,
  ModelRouterImpl,
  ModelSelectorImpl,
} from '@zhuxing/harness-model-router'
import type { ModelCapability, ModelConfigEntry, ModelOrchestrator, SelectorConfig } from '@zhuxing/harness-model-router'
import { FileMemoryStore, buildMemoryPrompt, buildSessionMemoryPrompt } from '@zhuxing/harness-memory'
import type { MemoryPromptEnhancer, MemoryScope, MemoryStore } from '@zhuxing/harness-memory'
import { FileSkillStore, SkillRegistryImpl } from '@zhuxing/harness-skills'
import type { SkillRegistry } from '@zhuxing/harness-skills'
import { createKnowledgeBase, defaultKnowledgeIndexPath } from '@zhuxing/harness-knowledge'
import type {
  EmbeddingProvider,
  KnowledgeBase,
  KnowledgeHit,
  KnowledgePromptEnhancer,
  KnowledgeRetriever,
} from '@zhuxing/harness-knowledge'

export interface BaseBundleOptions {
  apiKey: string
  baseUrl?: string
  model: string
  workspace: string
  level: PermissionLevel
  systemPrompt?: string
  maxSteps?: number
  temperature?: number
  /** 多子模型配置：提供后启用模型路由与编排（主模型即编排模型）。 */
  models?: ModelConfigEntry[]
  /** 路由行为（失败降级 / 选择器权重）。 */
  router?: { fallback?: boolean; selector?: SelectorConfig }
  /** 显式指定子模型 id：Agent 循环直接使用该子模型（经路由器，保留监控与降级）。 */
  modelId?: string
  /** 生图模型配置：提供后注册 generate_image 工具（OpenAI 兼容 images 端点）。 */
  imageModel?: ImageModelOptions
  /** token-plan 配置：单独配置的阿里云聚合 API；文本子模型注册进路由，首图模型启用 generate_image。 */
  tokenPlan?: TokenPlanOptions
  /** 记忆存储路径（缺省 ~/.zhuxing-harness/memories.json）。 */
  memoryPath?: string
  /** 技能目录（缺省 ~/.zhuxing-harness/skills/ + 工作区/.harness/skills/）。 */
  skillsDirs?: string[]
  /** 知识库配置：提供后启用自生长知识库（文档上传 → 分块 → embedding → RAG 注入）。 */
  knowledge?: KnowledgeOptions
}

/** 自生长知识库配置。 */
export interface KnowledgeOptions {
  /** 是否启用（缺省 false）。 */
  enabled?: boolean
  /** 全局索引文件路径（缺省 ~/.zhuxing-harness/knowledge/index.json）。 */
  path?: string
  /** 工作区索引文件路径（可选，提供后合并工作区知识）。 */
  workspacePath?: string
  /** embedding 配置（OpenAI 兼容 /embeddings；缺失时降级关键词检索）。 */
  embedding?: { baseUrl?: string; apiKey?: string; model?: string }
  /** 检索作用域（缺省 'global'）。 */
  scope?: 'global' | 'workspace'
  topK?: number
  /** 当前已禁用的专业化包 id（这些包的知识文档不参与检索）。 */
  excludeSpecIds?: string[]
}

/** 运行时暴露的知识库服务（供 server API 与运行时读取）。 */
export interface KnowledgeService {
  /** 是否启用。 */
  enabled: boolean
  /** 全局知识库（~/.zhuxing-harness/knowledge）。 */
  global: KnowledgeBase
  /** 工作区知识库（可选）。 */
  workspace?: KnowledgeBase
  /** embedding provider（可能不可用）。 */
  provider: EmbeddingProvider
  /** 是否具备向量化能力。 */
  hasEmbedding: boolean
  /** 更新已禁用的专业化包 id（这些包的知识文档不参与检索）。 */
  setExcludedSpecs(ids: string[]): void
}

/** 默认技能搜索目录：全局（~/.zhuxing-harness/skills/）+ 项目级（工作区/.harness/skills/）。 */
export function defaultSkillDirs(workspace?: string): string[] {
  const dirs = [join(homedir(), '.zhuxing-harness', 'skills')]
  if (workspace) dirs.push(join(resolve(workspace), '.harness', 'skills'))
  return dirs
}

/** 把模型可见消息转成可读文本，用于把参考对话渲染成上下文记录。 */
function messageToContextText(msg: import('@zhuxing/harness-llm').ChatMessage): string {
  const role = msg.role.toUpperCase()
  let body: string
  if (typeof msg.content === 'string') {
    body = msg.content
  } else {
    body = msg.content.map((p) => (p.type === 'text' ? p.text : '[image]')).join('\n')
  }
  if (msg.toolCalls?.length) {
    body = `${body}\n[调用工具: ${msg.toolCalls.map((c) => `${c.name}(${c.arguments})`).join(', ')}]`.trim()
  }
  if (msg.role === 'tool') {
    body = `[工具结果:${msg.name ?? 'tool'} ${msg.toolCallId ?? ''}] ${body}`.trim()
  }
  return `${role}: ${body}`
}

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
function dashScopeOrigin(baseUrl: string): string {
  try {
    return new URL(baseUrl).origin
  } catch {
    return baseUrl.replace(/\/+$/, '')
  }
}

/** token-plan 的 OpenAI 兼容文本端点基址：归一化为 `${origin}/compatible-mode/v1`。 */
function tokenPlanChatBase(baseUrl: string): string {
  try {
    return `${new URL(baseUrl).origin}/compatible-mode/v1`
  } catch {
    return baseUrl.replace(/\/+$/, '')
  }
}

/** token-plan 语音合成的 WebSocket 地址：统一为 `wss://<host>/api-ws/v1/inference`。 */
function tokenPlanWsUrl(baseUrl: string): string {
  try {
    return `wss://${new URL(baseUrl).host}/api-ws/v1/inference`
  } catch {
    return baseUrl.replace(/^http/, 'ws').replace(/\/+$/, '')
  }
}

/** DashScope 语音合成 WebSocket 客户端（run-task → continue-task → 收音频 → finish-task → task-finished）。 */
function dashScopeTts(params: {
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

/** shell 执行（Promise 化）。 */
function runShell(command: string, cwd: string): Promise<{ text: string }> {
  return new Promise((resolveResult) => {
    exec(command, { cwd, timeout: 60_000, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      const parts: string[] = []
      if (stdout.trim()) parts.push(stdout.trimEnd())
      if (stderr.trim()) parts.push(`[stderr] ${stderr.trimEnd()}`)
      if (err) parts.push(`[exit ${(err as NodeJS.ErrnoException & { code?: number | string }).code ?? 'error'}]`)
      resolveResult({ text: parts.length > 0 ? parts.join('\n') : '(无输出)' })
    })
  })
}

/**
 * 基础 bundle：以插件形态提供沙箱、会话、工具、模型、Agent 循环。
 * 每一层都可被用户 patch 替换（无特权核心）。cli 与 web 共用。
 */
export function baseBundlePlugins(opts: BaseBundleOptions): PluginDefinition[] {
  const workspace = resolve(opts.workspace)

  return [
    {
      name: 'harness-sandbox',
      description: '权限策略分级沙箱',
      apply(ctx) {
        ctx.provide('sandbox', createSandbox({ level: opts.level, workspace }))
      },
    },
    {
      name: 'harness-session',
      description: '追加式会话事件日志（config.storeDir 指定时持久化为 JSONL）',
      apply(ctx) {
        const storeDir = ctx.config.storeDir as string | undefined
        const store = storeDir ? new FileSessionStore(storeDir) : new MemorySessionStore()
        ctx.provide('sessionStore', store)
        ctx.provide('sessionService', new DefaultSessionService(store))
      },
    },
    {
      name: 'harness-tools',
      description: '工具注册表（统一执行管道）',
      apply(ctx) {
        ctx.provide('tools', new ToolRegistryImpl())
      },
    },
    {
      name: 'harness-llm',
      description: 'OpenAI 兼容模型适配器（可用 config.provider 注入自定义实现）',
      apply(ctx) {
        const override = ctx.config.provider as ChatProvider | undefined
        ctx.provide(
          'llm',
          override ?? new OpenAICompatibleProvider({ apiKey: opts.apiKey, baseUrl: opts.baseUrl, model: opts.model }),
        )
      },
    },
    {
      name: 'harness-core-tools',
      description: '内建文件/命令工具',
      inject: ['tools'],
      apply(ctx) {
        const tools = ctx.inject<ToolRegistry>('tools')
        tools.register({
          name: 'shell',
          description: '在 workspace 中执行一条 shell 命令并返回输出',
          schema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
          sandbox: { commandArg: 'command' },
          execute: async (args) => runShell(String(args.command ?? ''), workspace),
        })
        tools.register({
          name: 'read_file',
          description: '读取指定文件内容',
          schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
          execute: async (args) => {
            try {
              const content = await readFile(resolve(workspace, String(args.path)), 'utf-8')
              return { text: content.slice(0, 50_000) }
            } catch (err) {
              return { error: err instanceof Error ? err.message : String(err) }
            }
          },
        })
        tools.register({
          name: 'write_file',
          description: '写入文件内容（覆盖）',
          schema: {
            type: 'object',
            properties: { path: { type: 'string' }, content: { type: 'string' } },
            required: ['path', 'content'],
          },
          sandbox: { writeArg: 'path' },
          execute: async (args) => {
            try {
              await writeFile(resolve(workspace, String(args.path)), String(args.content ?? ''), 'utf-8')
              return { text: `已写入 ${args.path}` }
            } catch (err) {
              return { error: err instanceof Error ? err.message : String(err) }
            }
          },
        })
        tools.register({
          name: 'list_dir',
          description: '列出目录内容',
          schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
          execute: async (args) => {
            try {
              const entries = await readdir(resolve(workspace, String(args.path)), { withFileTypes: true })
              return { text: entries.map((e) => `${e.isDirectory() ? 'd' : '-'} ${e.name}`).join('\n') }
            } catch (err) {
              return { error: err instanceof Error ? err.message : String(err) }
            }
          },
        })
      },
    },
    {
      name: 'harness-image-tools',
      description: '生图工具（OpenAI 兼容 /images/generations，需配置 imageModel）',
      inject: ['tools'],
      apply(ctx) {
        // 生图模型优先级：显式 imageModel > token-plan 首个生图模型（DashScope 原生模式）
        let img: ImageModelOptions | undefined = opts.imageModel
        if (!img && opts.tokenPlan) {
          const imageModels = opts.tokenPlan.imageModels
          if (imageModels?.length) {
            img = {
              model: imageModels[0].model,
              baseUrl: opts.tokenPlan.baseUrl ?? DEFAULT_TOKEN_PLAN_ORIGIN,
              apiKey: opts.tokenPlan.apiKey ?? opts.apiKey,
              size: imageModels[0].size,
              mode: 'dashscope',
            }
          }
        }
        if (!img) return
        const tools = ctx.inject<ToolRegistry>('tools')
        const baseUrl = (img.baseUrl ?? opts.baseUrl ?? 'https://api.deepseek.com/v1').replace(/\/+$/, '')
        const apiKey = img.apiKey ?? opts.apiKey
        const unregister = tools.register({
          name: 'generate_image',
          description:
            '调用生图模型根据文字描述生成图片，返回图片 URL 或 base64。' +
            `当前生图模型：${img.model}。参数：prompt（必填）、size（可选，默认 ${img.size ?? (img.mode === 'dashscope' ? '1024*1024' : '1024x1024')}）。`,
          schema: {
            type: 'object',
            properties: {
              prompt: { type: 'string', description: '图片内容描述' },
              size: { type: 'string', description: '图片尺寸（如 1024*1024）' },
            },
            required: ['prompt'],
          },
          execute: async (args) => {
            const prompt = String(args.prompt ?? '')
            if (!prompt) return { error: '缺少 prompt 参数' }
            const size = (typeof args.size === 'string' && args.size) || img.size || '1024*1024'
            try {
              // DashScope 原生接口：token-plan 图像生成走 multimodal-generation 多模态端点（官方最佳实践）。
              // 双保险：显式 mode === 'dashscope'，或 baseUrl 指向 token-plan / aliyuncs / dashscope 网关时强制走多模态生图，
              // 避免 /images/generations（token-plan 网关不支持）返回 url error。
              const looksDashScope = img.mode === 'dashscope' || /token-plan|aliyuncs|dashscope/i.test(baseUrl || '')
              if (looksDashScope) {
                const origin = dashScopeOrigin(baseUrl)
                const model = img.model
                // token-plan 图像生成统一走 multimodal-generation 原生端点（官方最佳实践：input.messages[].content[].text）
                const endpoint = `${origin}/api/v1/services/aigc/multimodal-generation/generation`
                const body = { model, input: { messages: [{ role: 'user', content: [{ text: prompt }] }] }, parameters: { size } }
                const resp = await fetch(endpoint, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
                  body: JSON.stringify(body),
                })
                if (!resp.ok) {
                  const text = await resp.text().catch(() => '')
                  return { error: `生图请求失败（HTTP ${resp.status}）：${text.slice(0, 300)}` }
                }
                const data = (await resp.json()) as {
                  output?: {
                    results?: Array<{ url?: string; b64_json?: string }>
                    choices?: Array<{ message?: { content?: Array<{ image?: string; text?: string }> } }>
                  }
                }
                const out = data.output
                const imgUrl = out?.results?.[0]?.url ?? out?.choices?.[0]?.message?.content?.find((c) => c.image)?.image
                if (imgUrl) return { text: `图片已生成：${imgUrl}` }
                const b64 = out?.results?.[0]?.b64_json
                if (b64) return { text: `图片已生成（base64，${b64.length} 字符）：data:image/png;base64,${b64.slice(0, 64)}…` }
                return { error: '生图响应中未找到图片数据' }
              }

              // OpenAI 兼容 /images/generations
              const resp = await fetch(`${baseUrl}/images/generations`, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  Authorization: `Bearer ${apiKey}`,
                },
                body: JSON.stringify({
                  model: img.model,
                  prompt,
                  n: 1,
                  size,
                }),
              })
              if (!resp.ok) {
                const text = await resp.text().catch(() => '')
                return { error: `生图请求失败（HTTP ${resp.status}）：${text.slice(0, 300)}` }
              }
              const data = (await resp.json()) as { data?: Array<{ url?: string; b64_json?: string }> }
              const first = data.data?.[0]
              if (first?.url) return { text: `图片已生成：${first.url}` }
              if (first?.b64_json) return { text: `图片已生成（base64，${first.b64_json.length} 字符）：data:image/png;base64,${first.b64_json.slice(0, 64)}…` }
              return { error: '生图响应中未找到图片数据' }
            } catch (err) {
              return { error: err instanceof Error ? err.message : String(err) }
            }
          },
        })
        ctx.effect(() => unregister())
      },
    },
    {
      name: 'harness-token-plan-media',
      description: 'token-plan 媒体生成工具：视频生成（generate_video，异步任务+轮询）与语音合成（text_to_speech，DashScope WebSocket）',
      inject: ['tools'],
      apply(ctx) {
        const tokenPlan = opts.tokenPlan
        if (!tokenPlan) return
        const tools = ctx.inject<ToolRegistry>('tools')
        const disposers: Array<() => void> = []
        const origin = dashScopeOrigin(tokenPlan.baseUrl ?? DEFAULT_TOKEN_PLAN_ORIGIN)
        const apiKey = tokenPlan.apiKey ?? opts.apiKey

        // ===== 视频生成（默认取首个 videoModels 模型，可用 model 参数切换；支持 t2v/i2v/r2v）=====
        const videoModels = tokenPlan.videoModels ?? []
        const defaultVideoModel = videoModels[0]
        if (defaultVideoModel?.model) {
          const modelListDesc = videoModels
            .map((v) => `${v.model}${v.label ? `（${v.label}）` : ''}`)
            .join('、')
          disposers.push(
            tools.register({
              name: 'generate_video',
              description:
                '调用视频生成模型生成视频，返回可下载的视频 URL（MP4）。' +
                `可用模型：${modelListDesc}。参数：prompt（必填）、mode（可选，t2v=文生视频 / i2v=图生视频 / r2v=视频重绘，默认 t2v）、` +
                'model（可选，指定上述某个模型，默认用第一个）、image_url（可选，i2v/r2v 必填的参考图 URL，可多张用逗号分隔）、' +
                'resolution（可选，默认 720P）、ratio（可选，默认 16:9）、duration（可选，秒，默认 5）。' +
                '视频生成耗时约 1-5 分钟，工具会异步提交任务并轮询等待完成。',
              schema: {
                type: 'object',
                properties: {
                  prompt: { type: 'string', description: '视频内容描述（必填）' },
                  mode: { type: 'string', enum: ['t2v', 'i2v', 'r2v'], description: '生成类型：t2v 文生视频 / i2v 图生视频 / r2v 视频重绘，默认 t2v' },
                  model: { type: 'string', description: '视频模型（默认第一个）' },
                  image_url: { type: 'string', description: '参考图 URL（i2v/r2v 必填，多张用逗号分隔）' },
                  resolution: { type: 'string', description: '分辨率档位（如 480P / 720P / 1080P），默认 720P' },
                  ratio: { type: 'string', description: '宽高比（如 16:9 / 9:16 / 1:1 / 4:3 / 3:4），默认 16:9' },
                  duration: { type: 'number', description: '时长（秒，默认 5，范围 3-15）' },
                },
                required: ['prompt'],
              },
              execute: async (args) => {
                const prompt = String(args.prompt ?? '').trim()
                if (!prompt) return { error: '缺少 prompt 参数' }
                const modeRaw = String(args.mode ?? 't2v').toLowerCase().trim()
                const mode: 't2v' | 'i2v' | 'r2v' = modeRaw === 'i2v' || modeRaw === 'r2v' ? modeRaw : 't2v'
                const imageUrls = (() => {
                  const raw = args.image_url
                  if (!raw) return []
                  if (Array.isArray(raw)) return raw.map(String).filter(Boolean)
                  return String(raw)
                    .split(',')
                    .map((s) => s.trim())
                    .filter(Boolean)
                })()
                if (mode !== 't2v' && imageUrls.length === 0) {
                  return { error: `${mode === 'i2v' ? '图生视频' : '视频重绘'}需要 image_url 参考图参数` }
                }
                // 模型选择：优先按 model 参数匹配，否则用第一个
                const reqModel = typeof args.model === 'string' ? args.model.trim() : ''
                const chosen = (reqModel
                  ? videoModels.find((v) => v.model === reqModel || v.label === reqModel)
                  : undefined) ?? videoModels[0]
                if (reqModel && !chosen) {
                  return { error: `未找到视频模型「${reqModel}」，可用：${modelListDesc}` }
                }
                const videoModel = chosen!
                const resolution = (typeof args.resolution === 'string' && args.resolution) || '720P'
                const ratio = (typeof args.ratio === 'string' && args.ratio) || '16:9'
                const duration = typeof args.duration === 'number' && args.duration > 0 ? Math.round(args.duration) : 5
                const input: Record<string, unknown> = { prompt }
                if (mode !== 't2v') input.img_url = imageUrls.length === 1 ? imageUrls[0] : imageUrls
                try {
                  // 1. 提交异步任务（X-DashScope-Async: enable）
                  const submitResp = await fetch(`${origin}/api/v1/services/aigc/video-generation/video-synthesis`, {
                    method: 'POST',
                    headers: {
                      'Content-Type': 'application/json',
                      Authorization: `Bearer ${apiKey}`,
                      'X-DashScope-Async': 'enable',
                    },
                    body: JSON.stringify({
                      model: videoModel.model,
                      input,
                      parameters: { resolution, ratio, duration },
                    }),
                  })
                  if (!submitResp.ok) {
                    const text = await submitResp.text().catch(() => '')
                    return { error: `视频生成提交失败（HTTP ${submitResp.status}）：${text.slice(0, 300)}` }
                  }
                  const submitData = (await submitResp.json()) as {
                    output?: { task_id?: string; task_status?: string }
                    code?: string
                    message?: string
                  }
                  const taskId = submitData.output?.task_id
                  if (!taskId) {
                    return { error: `视频生成提交失败：未返回 task_id（${submitData.code ?? submitData.message ?? '未知错误'}）` }
                  }
                  // 2. 轮询任务状态（每 15 秒）
                  const statusUrl = `${origin}/api/v1/tasks/${taskId}`
                  let lastStatus = submitData.output?.task_status ?? 'PENDING'
                  for (let attempt = 0; attempt < 120; attempt++) {
                    await new Promise((r) => setTimeout(r, 15_000))
                    const pollResp = await fetch(statusUrl, { headers: { Authorization: `Bearer ${apiKey}` } })
                    if (!pollResp.ok) {
                      return { error: `视频生成状态查询失败（HTTP ${pollResp.status}）` }
                    }
                    const pollData = (await pollResp.json()) as {
                      output?: { task_status?: string; video_url?: string; code?: string; message?: string }
                    }
                    const status = pollData.output?.task_status ?? ''
                    if (status) lastStatus = status
                    if (status === 'SUCCEEDED') {
                      const videoUrl = pollData.output?.video_url
                      if (!videoUrl) return { error: '视频生成成功但未返回 video_url' }
                      return { text: `视频已生成（task_id: ${taskId}，链接 24 小时内有效，请尽快下载）：${videoUrl}` }
                    }
                    if (status === 'FAILED' || status === 'CANCELED' || status === 'UNKNOWN') {
                      return {
                        error: `视频生成${status === 'FAILED' ? '失败' : status === 'CANCELED' ? '已取消' : '任务不存在或已过期'}：${
                          pollData.output?.message ?? pollData.output?.code ?? ''
                        }`,
                      }
                    }
                  }
                  return { error: `视频生成超时（最后状态：${lastStatus}）` }
                } catch (err) {
                  return { error: err instanceof Error ? err.message : String(err) }
                }
              },
            }),
          )
        }

        // ===== 语音合成（首个 voiceModels 模型；DashScope WebSocket 协议）=====
        const voiceModel = tokenPlan.voiceModels?.[0]
        if (voiceModel?.model) {
          disposers.push(
            tools.register({
              name: 'text_to_speech',
              description:
                '调用语音合成模型将文本转为语音，生成音频文件并返回本地路径。' +
                `当前语音模型：${voiceModel.model}。参数：text（必填）、voice（可选，音色）、format（可选，mp3/wav/pcm）。`,
              schema: {
                type: 'object',
                properties: {
                  text: { type: 'string', description: '要合成的文本（必填）' },
                  voice: { type: 'string', description: '音色（如 Cherry / Serena / Ethan / Chelsie）' },
                  format: { type: 'string', description: '音频格式（mp3 / wav / pcm），默认 mp3' },
                },
                required: ['text'],
              },
              execute: async (args) => {
                const text = String(args.text ?? '').trim()
                if (!text) return { error: '缺少 text 参数' }
                const voice = typeof args.voice === 'string' && args.voice ? args.voice : 'Cherry'
                const format = typeof args.format === 'string' && args.format ? args.format : 'mp3'
                try {
                  const url = tokenPlanWsUrl(tokenPlan.baseUrl ?? DEFAULT_TOKEN_PLAN_ORIGIN)
                  const audio = await dashScopeTts({ url, apiKey, model: voiceModel.model, voice, format, text })
                  const ttsDir = join(workspace, '.harness', 'tts')
                  await mkdir(ttsDir, { recursive: true })
                  const filePath = join(ttsDir, `tts-${Date.now()}.${format}`)
                  await writeFile(filePath, audio)
                  return { text: `语音已生成：${filePath}（${audio.length} 字节）` }
                } catch (err) {
                  return { error: err instanceof Error ? err.message : String(err) }
                }
              },
            }),
          )
        }

        ctx.effect(() => {
          for (const dispose of disposers) dispose()
        })
      },
    },
    {
      name: 'harness-memory',
      description: '跨会话记忆服务（用户偏好 / 项目上下文 / 自动学习），运行前注入相关记忆到 systemPrompt',
      inject: ['tools'],
      apply(ctx) {
        const store = new FileMemoryStore(opts.memoryPath)
        const workspace = opts.workspace
        const enhancer = buildMemoryPrompt(store, workspace)
        ctx.provide('memoryStore', store)
        ctx.provide('memoryPromptEnhancer', enhancer)

        const tools = ctx.inject<ToolRegistry>('tools')
        const unregisterRemember = tools.register({
          name: 'remember',
          description:
            '记住一条事实或偏好，供后续对话使用。参数：content（必填，要记住的内容）、' +
            'scope（user=跨项目偏好 / project=项目上下文 / auto=自动学习 / session=仅当前对话私有，默认 auto）、' +
            'tags（可选，标签数组，如 code-style/tech-stack/decision）。',
          schema: {
            type: 'object',
            properties: {
              content: { type: 'string', description: '要记住的内容' },
              scope: {
                type: 'string',
                enum: ['user', 'project', 'auto', 'session'],
                description: '记忆作用域（默认 auto；session 仅对当前对话可见）',
              },
              tags: { type: 'array', items: { type: 'string' }, description: '标签（可选）' },
            },
            required: ['content'],
          },
          execute: async (args, ctx) => {
            const content = String(args.content ?? '').trim()
            if (!content) return { error: '缺少 content 参数' }
            const scope = (typeof args.scope === 'string' ? args.scope : 'auto') as MemoryScope
            const entry = await store.add({
              scope,
              content,
              tags: Array.isArray(args.tags) ? args.tags.map(String) : undefined,
              workspace: scope === 'project' ? workspace : undefined,
              sessionId: scope === 'session' ? ctx.sessionId : undefined,
            })
            const where = scope === 'session' ? '（当前对话私有）' : ''
            return { text: `已记住 [${entry.scope}]${where}：${content}（id: ${entry.id}）` }
          },
        })
        const unregisterRecall = tools.register({
          name: 'recall',
          description:
            '查询已记住的事实与偏好。参数：q（可选，关键词搜索）、scope（可选，按作用域过滤；session=仅当前对话）。' +
            '无参数时返回全部记忆。',
          schema: {
            type: 'object',
            properties: {
              q: { type: 'string', description: '搜索关键词（匹配内容与标签）' },
              scope: { type: 'string', enum: ['user', 'project', 'auto', 'session'], description: '按作用域过滤' },
            },
          },
          execute: async (args, ctx) => {
            const scope = typeof args.scope === 'string' ? (args.scope as MemoryScope) : undefined
            const entries = await store.list({
              q: typeof args.q === 'string' ? args.q : undefined,
              scope,
              sessionId: scope === 'session' ? ctx.sessionId : undefined,
            })
            if (!entries.length) return { json: entries, text: '无记忆' }
            const lines = entries.map((e) => {
              const tags = e.tags?.length ? ` {${e.tags.join(',')}}` : ''
              return `- [${e.scope}]${tags} ${e.content}`
            })
            return { json: entries, text: `找到 ${entries.length} 条记忆：\n${lines.join('\n')}` }
          },
        })
        ctx.effect(() => {
          unregisterRemember()
          unregisterRecall()
        })
      },
    },
    {
      name: 'harness-knowledge',
      description:
        '自生长知识库：文档上传 → 分块 → 向量化（OpenAI 兼容 embeddings，缺省降级关键词检索）→ RAG 检索注入（注册 search_knowledge 工具）',
      inject: ['tools'],
      apply(ctx) {
        const knowledge = opts.knowledge
        if (!knowledge?.enabled) return

        const embedding = knowledge.embedding
        const kbGlobal = createKnowledgeBase({
          path: knowledge.path ?? defaultKnowledgeIndexPath(),
          embedding,
          scope: knowledge.scope,
          topK: knowledge.topK,
        })
        let kbWorkspace: KnowledgeBase | undefined
        if (knowledge.workspacePath) {
          kbWorkspace = createKnowledgeBase({ path: knowledge.workspacePath, embedding, scope: 'workspace', topK: knowledge.topK })
        }

        const retrievers: KnowledgeRetriever[] = [kbGlobal.retriever]
        if (kbWorkspace) retrievers.push(kbWorkspace.retriever)
        const disabledSpecIds = new Set<string>(knowledge.excludeSpecIds ?? [])

        // 合并检索器：聚合多个存储（全局 + 工作区）的结果，按分数排序去重。
        const combinedRetriever: KnowledgeRetriever = {
          async search(query) {
            const per = Math.max(2, Math.ceil((query.topK ?? knowledge.topK ?? 4) * 2))
            const exclude = Array.from(disabledSpecIds)
            const results: KnowledgeHit[] = []
            for (const r of retrievers) {
              try {
                results.push(...(await r.search({ ...query, excludeSpecIds: exclude, topK: per })))
              } catch {
                /* 单存储检索失败时忽略，保持其余结果 */
              }
            }
            results.sort((a, b) => b.score - a.score)
            const seen = new Set<string>()
            const dedup = results.filter((h) => {
              if (seen.has(h.chunkId)) return false
              seen.add(h.chunkId)
              return true
            })
            return dedup.slice(0, query.topK ?? knowledge.topK ?? 4)
          },
        }

        // 知识注入增强器：检索相关块追加到 systemPrompt（上限 8KB）。
        const maxChars = 8192
        const enhancer: KnowledgePromptEnhancer = async (basePrompt, userInput) => {
          try {
            const hits = await combinedRetriever.search({
              q: userInput,
              scope: knowledge.scope,
              topK: knowledge.topK ?? 4,
            })
            if (!hits.length) return basePrompt
            const lines: string[] = []
            let total = 0
            for (const h of hits) {
              const line = `- [${h.docTitle}] ${h.text.trim()}`
              if (total + line.length + 1 > maxChars) break
              lines.push(line)
              total += line.length + 1
            }
            if (!lines.length) return basePrompt
            const block = `\n\n# Knowledge Base Context\nThe following are relevant excerpts from the user's knowledge base. Use them as authoritative background when answering the current question:\n${lines.join('\n')}`
            return basePrompt + block
          } catch {
            return basePrompt
          }
        }

        // 对外可调整的启用/禁用专业化集合（禁用包的知识文档不参与检索）。
        const service: KnowledgeService = {
          enabled: true,
          global: kbGlobal,
          workspace: kbWorkspace,
          provider: kbGlobal.provider,
          hasEmbedding: kbGlobal.hasEmbedding,
          setExcludedSpecs(ids: string[]): void {
            disabledSpecIds.clear()
            for (const id of ids) disabledSpecIds.add(id)
          },
        }
        ctx.provide('knowledgeStore', kbGlobal.store)
        ctx.provide('knowledgeEnhancer', enhancer)
        ctx.provide('knowledgeService', service)

        const tools = ctx.inject<ToolRegistry>('tools')
        const unregisterSearch = tools.register({
          name: 'search_knowledge',
          description:
            '检索知识库中与问题相关的文档片段（RAG）。参数：q（必填，检索词）、scope（可选，global/workspace）、topK（可选，默认 4）。' +
            '返回命中片段、来源文档标题与相关度分数。',
          schema: {
            type: 'object',
            properties: {
              q: { type: 'string', description: '检索词' },
              scope: { type: 'string', enum: ['global', 'workspace'], description: '检索作用域（默认不限）' },
              topK: { type: 'integer', description: '返回条数（默认 4）' },
            },
            required: ['q'],
          },
          execute: async (args) => {
            const q = String(args.q ?? '').trim()
            if (!q) return { error: '缺少 q 参数' }
            const scope = typeof args.scope === 'string' ? (args.scope as 'global' | 'workspace') : undefined
            const topK = typeof args.topK === 'number' ? args.topK : undefined
            const hits = await combinedRetriever.search({ q, scope, topK, workspace: workspace ?? undefined })
            if (!hits.length) return { json: [], text: '知识库中未检索到相关内容' }
            const lines = hits.map((h) => `- [${h.docTitle}] (score ${h.score.toFixed(2)}) ${h.text.trim()}`)
            return { json: hits, text: `命中 ${hits.length} 条：\n${lines.join('\n')}` }
          },
        })
        ctx.effect(() => unregisterSearch())
      },
    },
    {
      name: 'harness-skill-loader',
      description: '技能系统：提示词模板 + 输入参数 + 工具子集，可复用可分享的经验包（注册 use_skill 工具）',
      inject: ['tools'],
      apply(ctx) {
        const dirs = opts.skillsDirs ?? defaultSkillDirs(opts.workspace)
        const store = new FileSkillStore({ dirs })
        const registry = new SkillRegistryImpl()
        // 启动时从文件存储加载全部技能到运行时注册表
        void store.list().then((skills) => {
          for (const skill of skills) registry.register(skill)
        })
        ctx.provide('skillStore', store)
        ctx.provide('skillRegistry', registry)

        const tools = ctx.inject<ToolRegistry>('tools')
        const unregisterUseSkill = tools.register({
          name: 'use_skill',
          description:
            '调用一个已安装的技能（可复用的提示词模板）。参数：skill（必填，技能名）、' +
            'args（必填，技能输入参数对象，需匹配技能 inputs schema）。返回渲染后的提示词。',
          schema: {
            type: 'object',
            properties: {
              skill: { type: 'string', description: '技能名（可通过 list_skills 查看）' },
              args: { type: 'object', description: '技能输入参数' },
            },
            required: ['skill', 'args'],
          },
          execute: async (args) => {
            const skillName = String(args.skill ?? '')
            const skillArgs = (args.args as Record<string, unknown>) ?? {}
            try {
              const result = await registry.run(skillName, skillArgs)
              return {
                text: `技能「${skillName}」已渲染，请按以下提示词执行：\n\n${result.prompt}${
                  result.tools ? `\n\n（建议启用的工具子集：${result.tools.join(', ')}）` : ''
                }`,
              }
            } catch (err) {
              return { error: err instanceof Error ? err.message : String(err) }
            }
          },
        })
        const unregisterListSkills = tools.register({
          name: 'list_skills',
          description: '列出当前已安装的所有技能（名称、描述、图标、分类、标签），供决策使用。',
          schema: { type: 'object', properties: {}, required: [] },
          execute: async () => {
            const list = registry.list().map((s) => ({
              name: s.name,
              description: s.description,
              icon: s.icon,
              category: s.category,
              tags: s.tags,
            }))
            return { json: list, text: `共 ${list.length} 个技能` }
          },
        })
        ctx.effect(() => {
          unregisterUseSkill()
          unregisterListSkills()
        })
      },
    },
    {
      name: 'harness-model-router',
      description: '多子模型路由与编排：模型注册表（热插拔）、实时监控、选择算法、统一交互接口、模型间通信协议',
      inject: ['llm', 'tools'],
      apply(ctx) {
        const mainLlm = ctx.inject<ChatProvider>('llm')
        const tools = ctx.inject<ToolRegistry>('tools')
        const baseUrl = opts.baseUrl ?? 'https://api.deepseek.com/v1'

        const registry = new ModelRegistryImpl()
        const monitor = new ModelMonitorImpl()
        const selector = new ModelSelectorImpl(registry, monitor, opts.router?.selector)
        const router = new ModelRouterImpl(registry, monitor, selector, { fallback: opts.router?.fallback })
        const orchestrator: ModelOrchestrator = new ModelOrchestratorImpl(registry, monitor, router)

        // 1. 注册主编排模型（默认模型 id 为 'default'，对应主 llm）
        registry.register(
          { id: 'default', label: opts.model, capabilities: ['general'], contextWindow: opts.models?.find((m) => m.id === 'default')?.contextWindow },
          mainLlm,
        )
        // 2. 注册子模型（config.models）
        const disposers: Array<() => void> = []
        for (const entry of opts.models ?? []) {
          if (entry.id === 'default') continue // 主模型已在上面注册
          if (registry.has(entry.id)) continue // 与已注册模型（含下方 token-plan 文本模型）id 重复时跳过，避免重复注册报错使整个服务崩溃
          const provider = new OpenAICompatibleProvider({
            apiKey: entry.apiKey ?? opts.apiKey,
            baseUrl: entry.baseUrl ?? baseUrl,
            model: entry.model,
            timeoutMs: entry.timeoutMs,
          })
          disposers.push(
            registry.register(
              { id: entry.id, label: entry.label ?? entry.id, capabilities: entry.capabilities, contextWindow: entry.contextWindow, costPer1k: entry.costPer1k },
              provider,
            ),
          )
        }
        // 2.5 注册 token-plan 文本子模型（单独配置的阿里云聚合 API，走兼容模式文本端点）
        const tokenPlan = opts.tokenPlan
        if (tokenPlan) {
          const tpChatBase = tokenPlanChatBase(tokenPlan.baseUrl ?? DEFAULT_TOKEN_PLAN_ORIGIN)
          const tpApiKey = tokenPlan.apiKey ?? opts.apiKey
          for (const entry of tokenPlan.textModels ?? []) {
            if (entry.id === 'default') continue // 主模型已在上面注册
            if (registry.has(entry.id)) continue // config.models 已注册同 id → 跳过，避免重复注册报错使整个服务崩溃
            const provider = new OpenAICompatibleProvider({
              apiKey: entry.apiKey ?? tpApiKey,
              baseUrl: entry.baseUrl ?? tpChatBase,
              model: entry.model,
              timeoutMs: entry.timeoutMs,
            })
            disposers.push(
              registry.register(
                { id: entry.id, label: entry.label ?? entry.id, capabilities: entry.capabilities, contextWindow: entry.contextWindow, costPer1k: entry.costPer1k },
                provider,
              ),
            )
          }
        }

        // 3. 提供服务（统一交互接口 / 监控 / 选择 / 编排）
        ctx.provide('modelRegistry', registry)
        ctx.provide('modelMonitor', monitor)
        ctx.provide('modelSelector', selector)
        ctx.provide('modelRouter', router)
        ctx.provide('orchestrator', orchestrator)

        // 4. 模型间通信协议工具：编排模型动态选择子模型
        const unregisterPick = tools.register({
          name: 'pick_model',
          description:
            '动态选择一个子模型执行子任务并返回统一格式结果（由主编排模型调用）。' +
            '根据任务需求、上下文长度与实时性能指标自动选择子模型；可显式指定 modelId。' +
            '返回 { ok, modelId, content, usage, latencyMs, estCost, error? }。',
          schema: {
            type: 'object',
            properties: {
              task: { type: 'string', description: '子任务描述（将作为子模型输入）' },
              context: { type: 'string', description: '附加上下文（可省略）' },
              modelId: { type: 'string', description: '可选：显式指定子模型 id（否则自动选择）' },
              capabilities: {
                type: 'array',
                items: { type: 'string' },
                description: '可选：能力偏好（如 code / reasoning / fast）',
              },
              maxTokens: { type: 'integer', description: '可选：子模型最大输出 token' },
              temperature: { type: 'number', description: '可选：采样温度' },
            },
            required: ['task'],
          },
          execute: async (args) => {
            const result = await orchestrator.delegate({
              task: String(args.task ?? ''),
              context: args.context ? String(args.context) : undefined,
              hints: {
                modelId: args.modelId ? String(args.modelId) : undefined,
                capabilities: Array.isArray(args.capabilities) ? (args.capabilities as ModelCapability[]) : undefined,
                maxTokens: typeof args.maxTokens === 'number' ? args.maxTokens : undefined,
                temperature: typeof args.temperature === 'number' ? args.temperature : undefined,
              },
            })
            return { json: result }
          },
        })

        // 5. 模型发现工具：编排模型查看可用子模型与实时指标
        const unregisterList = tools.register({
          name: 'list_models',
          description:
            '列出当前可用子模型及其实时性能指标（成功率 / 平均延迟 / 调用次数 / 成本），供主编排模型决策。返回 JSON 数组。',
          schema: { type: 'object', properties: {}, required: [] },
          execute: async () => ({ json: orchestrator.listModels() }),
        })

        // 6. 热插拔：插件卸载时注销全部子模型与工具
        ctx.effect(() => {
          for (const dispose of disposers) dispose()
          unregisterPick()
          unregisterList()
        })
      },
    },
    {
      name: 'harness-agent',
      description: 'Agent 循环（turn/step 编排）',
      inject: ['llm', 'tools', 'sessionService'],
      apply(ctx) {
        let llm = ctx.inject<ChatProvider>('llm')
        // 显式指定子模型：经路由器固定 modelId（保留监控埋点与失败降级）
        if (opts.modelId) {
          const router = ctx.injectOptional<import('@zhuxing/harness-model-router').ModelRouter>('modelRouter')
          if (router) {
            const fixedId = opts.modelId
            llm = {
              name: `router:${fixedId}`,
              chat: (messages, options) => router.chat(messages, { ...options, modelId: fixedId }),
              stream: (messages, options) => router.stream(messages, { ...options, modelId: fixedId }),
            }
          }
        }
        const tools = ctx.inject<ToolRegistry>('tools')
        const sessionService = ctx.inject<SessionService>('sessionService')
        const sandbox = ctx.injectOptional<import('@zhuxing/harness-sandbox').Sandbox>('sandbox')
        const memoryEnhancer = ctx.injectOptional<MemoryPromptEnhancer>('memoryPromptEnhancer')
        const memoryStore = ctx.injectOptional<MemoryStore>('memoryStore')
        const knowledgeEnhancer = ctx.injectOptional<KnowledgePromptEnhancer>('knowledgeEnhancer')
        const skillRegistry = ctx.injectOptional<SkillRegistry>('skillRegistry')
        const baseOptions: AgentOptions = {
          systemPrompt: opts.systemPrompt,
          maxSteps: opts.maxSteps,
          temperature: opts.temperature,
        }
        ctx.provide('agent', {
          run: async (
            userInput: string,
            sessionId?: string,
            streamOpts?: {
              onToken?: (token: string) => void
              history?: import('@zhuxing/harness-llm').ChatMessage[]
              attachments?: Array<{ type: 'image'; dataUrl: string }>
              /** 参考对话 id：注入该对话完整事件记录（重建为历史）+ 该对话私有记忆摘要作为本轮上下文。 */
              contextSessionId?: string
            },
          ) => {
            const session = sessionId ? await sessionService.get(sessionId) : await sessionService.create()
            const { AgentLoop } = await import('@zhuxing/harness-agent')
            // 上下文续接：调用方未传 history 时，从会话事件重建历史（system 由循环注入）
            let history = streamOpts?.history
            if (!history && sessionId) {
              const { buildMessagesFromEvents } = await import('@zhuxing/harness-session')
              const events = await session.events()
              history = buildMessagesFromEvents(events)
            }
            // 记忆增强：运行前注入相关记忆到 systemPrompt（不替换原 prompt）
            let systemPrompt = baseOptions.systemPrompt
            if (memoryEnhancer) {
              systemPrompt = await memoryEnhancer(baseOptions.systemPrompt ?? '', userInput)
            }
            // 参考对话上下文：指定 contextSessionId 时，注入被引用对话的完整事件记录（重建为历史）+ 该对话私有记忆摘要
            const contextSessionId = streamOpts?.contextSessionId
            if (contextSessionId && memoryStore) {
              try {
                const refSession = await sessionService.get(contextSessionId)
                const { buildMessagesFromEvents } = await import('@zhuxing/harness-session')
                const refMessages = buildMessagesFromEvents(await refSession.events())
                const refRecord = refMessages.length
                  ? refMessages.map(messageToContextText).filter(Boolean).join('\n')
                  : '*（该对话暂无记录）*'
                const recordBlock = [
                  '',
                  '# Referenced Conversation Context',
                  `You are continuing with context from another conversation (session ${contextSessionId}). Use its record and private memory below as background.`,
                  '',
                  '## Conversation Record',
                  refRecord,
                ].join('\n')
                systemPrompt = `${systemPrompt}${recordBlock}`
                // 追加被引用对话的私有记忆摘要（buildSessionMemoryPrompt 自带标题与说明，无记忆时原样返回）
                systemPrompt = await buildSessionMemoryPrompt(memoryStore, contextSessionId)(systemPrompt, userInput)
              } catch {
                // 被引用会话不存在或事件读取失败时忽略，保持正常对话
              }
            }
            // 知识库增强：检索相关知识块追加到 systemPrompt（在记忆之后、技能之前）
            if (knowledgeEnhancer) {
              systemPrompt = await knowledgeEnhancer(systemPrompt ?? '', userInput)
            }
            // 技能增强：若输入以 /skill <name> 开头，渲染模板并追加到 systemPrompt
            const skillMatch = userInput.match(/^\/skill\s+(\S+)(?:\s+([\s\S]+))?$/)
            if (skillMatch && skillRegistry) {
              const skillName = skillMatch[1]
              let skillArgs: Record<string, unknown> = {}
              if (skillMatch[2]) {
                try {
                  skillArgs = JSON.parse(skillMatch[2])
                } catch {
                  skillArgs = { input: skillMatch[2] }
                }
              }
              try {
                const result = await skillRegistry.run(skillName, skillArgs)
                systemPrompt = `${systemPrompt ?? ''}\n\n${result.prompt}`.trim()
              } catch {
                // skill 执行失败时忽略，正常对话
              }
            }
            const loop = new AgentLoop(
              {
                llm,
                tools,
                session,
                sandbox,
                emit: (event, payload) => ctx.emit(event, payload),
                logger: ctx.logger,
              },
              { ...baseOptions, systemPrompt, ...(streamOpts ?? {}) },
            )
            return loop.run(userInput, history)
          },
        })
      },
    },
  ]
}
