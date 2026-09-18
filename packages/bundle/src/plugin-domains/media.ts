/** 媒体生成工具插件：生图（generate_image）+ token-plan 视频生成 / 语音合成。 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { PluginDefinition } from '@zhuxing/harness-kernel'
import type { ToolRegistry } from '@zhuxing/harness-tools'
import type { BaseBundleOptions } from '../options.js'
import { dashScopeOrigin, dashScopeTts, DEFAULT_TOKEN_PLAN_ORIGIN, tokenPlanWsUrl } from '../token-plan.js'

/**
 * @param deps.workspace 已 resolve 的绝对工作区路径（语音文件落在工作区 .harness/tts 下）
 */
export function mediaPlugins(
  deps: Pick<BaseBundleOptions, 'workspace' | 'apiKey' | 'baseUrl' | 'imageModel' | 'tokenPlan'>,
): PluginDefinition[] {
  return [
    {
      name: 'harness-image-tools',
      description: '生图工具（OpenAI 兼容 /images/generations，需配置 imageModel）',
      inject: ['tools'],
      apply(ctx) {
        // 生图模型优先级：显式 imageModel > token-plan 首个生图模型（DashScope 原生模式）
        let img = deps.imageModel
        if (!img && deps.tokenPlan) {
          const imageModels = deps.tokenPlan.imageModels
          if (imageModels?.length) {
            img = {
              model: imageModels[0].model,
              baseUrl: deps.tokenPlan.baseUrl ?? DEFAULT_TOKEN_PLAN_ORIGIN,
              apiKey: deps.tokenPlan.apiKey ?? deps.apiKey,
              size: imageModels[0].size,
              mode: 'dashscope',
            }
          }
        }
        if (!img) return
        const tools = ctx.inject<ToolRegistry>('tools')
        const baseUrl = (img.baseUrl ?? deps.baseUrl ?? 'https://api.deepseek.com/v1').replace(/\/+$/, '')
        const apiKey = img.apiKey ?? deps.apiKey
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
        const tokenPlan = deps.tokenPlan
        if (!tokenPlan) return
        const tools = ctx.inject<ToolRegistry>('tools')
        const disposers: Array<() => void> = []
        const origin = dashScopeOrigin(tokenPlan.baseUrl ?? DEFAULT_TOKEN_PLAN_ORIGIN)
        const apiKey = tokenPlan.apiKey ?? deps.apiKey

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
                  const ttsDir = join(deps.workspace, '.harness', 'tts')
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
  ]
}
