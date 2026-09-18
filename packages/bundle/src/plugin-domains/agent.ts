/** Agent 循环插件：装配 LLM / 工具 / 会话 / 沙箱 / 增强器，提供 `agent` 服务（含精炼与目标校验兜底）。 */
import { dirname, join } from 'node:path'
import type { AgentOptions } from '@zhuxing/harness-agent'
import type { PluginDefinition } from '@zhuxing/harness-kernel'
import type { KnowledgePromptEnhancer } from '@zhuxing/harness-knowledge'
import type { ChatProvider } from '@zhuxing/harness-llm'
import { buildSessionMemoryPrompt, defaultMemoryPath } from '@zhuxing/harness-memory'
import type { MemoryPromptEnhancer, MemoryStore } from '@zhuxing/harness-memory'
import type { SessionService } from '@zhuxing/harness-session'
import type { SkillRegistry } from '@zhuxing/harness-skills'
import type { ToolRegistry } from '@zhuxing/harness-tools'
import { buildDeliveryBrief, DELIVERY_BRIEF_TAG, MAX_SESSION_BRIEFS, MAX_REF_CONTEXT_CHARS, messageToContextText, pickRecentBriefs } from '../delivery-brief.js'
import type { BaseBundleOptions } from '../options.js'
import { isStructuredBrief, looksLikeSmalltalk, REFINE_HISTORY_TURNS, REFINE_MAX_TOKENS, REFINE_NOTE_CHARS, REFINER_PROMPT } from '../refine.js'
import { buildEnvironmentNotes } from '../workspace-profile.js'

/**
 * @param deps.workspace 调用方传入的工作区路径原值（用于环境索引渲染，不做 resolve）
 */
export function agentPlugins(
  deps: Pick<
    BaseBundleOptions,
    | 'workspace'
    | 'model'
    | 'modelId'
    | 'systemPrompt'
    | 'maxSteps'
    | 'temperature'
    | 'refineInstruction'
    | 'verifyGoal'
    | 'maxGoalVerify'
    | 'memoryPath'
  >,
): PluginDefinition[] {
  return [
    {
      name: 'harness-agent',
      description: 'Agent 循环（turn/step 编排）',
      inject: ['llm', 'tools', 'sessionService'],
      apply(ctx) {
        let llm = ctx.inject<ChatProvider>('llm')
        // 显式指定子模型：经路由器固定 modelId（保留监控埋点与失败降级）
        if (deps.modelId) {
          const router = ctx.injectOptional<import('@zhuxing/harness-model-router').ModelRouter>('modelRouter')
          if (router) {
            const fixedId = deps.modelId
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
        // 内置目标校验器：用一次轻量模型自检，判断最终答复是否真正达成用户目标。
        // 仅当本回合调用过工具时由 AgentLoop 触发；校验器无法判定时放行，避免打断正常完成。
        const defaultVerifyGoal: NonNullable<AgentOptions['verifyGoal']> = async (ctx) => {
          try {
            const check = await llm.chat(
              [
                {
                  role: 'system',
                  content:
                    '你是任务完成度校验器。依据「用户目标」「本轮工具执行记录」「本回合模型已输出的全部内容（含中途步骤）」「模型最终答复」判断任务是否真正完成。' +
                    '判定规则：' +
                    '1) 以工具执行记录为唯一事实依据，不得断言记录里没有发生的事（记录显示写入/运行成功，就不能说「未创建」「未运行」）；' +
                    '2) 交付判定看「本回合已输出内容」全量：结果清单/表格若出现在中途步骤，就已交付给用户，末尾那句收尾语（如「见上表」）不算缺交付；' +
                    '3) 若工具已把目标做实、只是模型全程没向用户交代结果，回答「未完成：未交付结果（补一段结果说明即可）」，不要要求重做已完成的动作；' +
                    '4) 证据不足以判断时回答 OK，不要猜测；' +
                    '5) 只回答一个词 OK，或「未完成：<缺什么/哪里不对>」，不要啰嗦。',
                },
                {
                  role: 'user',
                  content:
                    `用户目标：\n${ctx.userInput}\n\n` +
                    `本轮工具执行记录（共 ${ctx.toolsUsed} 次）：\n${ctx.evidence?.trim() || '（无）'}\n\n` +
                    `本回合模型已输出的全部内容（含中途步骤）：\n${(ctx.delivered ?? ctx.finalContent).trim() || '（无）'}\n\n` +
                    `模型最终答复：\n${ctx.finalContent}`,
                },
              ],
              { model: deps.model },
            )
            const text = (check.content ?? '').trim()
            if (/^未完成[：:]?/i.test(text)) return { ok: false, detail: text.replace(/^未完成[：:]?\s*/i, '') }
            return { ok: /^OK$/i.test(text) }
          } catch (err) {
            // 保守拒绝：校验器调用失败不得默认为「已完成」，否则校验链路一故障就等于放弃校验。
            const msg = err instanceof Error ? err.message : String(err)
            return { ok: false, detail: `目标校验器执行失败：${msg}` }
          }
        }
        // 内置指令精炼器：本轮执行前把用户的口语指令改写成任务书（目标/交付物/约束/验收/步骤）。
        // 用一次关思维链的轻量调用换取「按结构化任务执行」；判定无需拆解则回 SKIP，退回原始指令。
        // 这里不做重试与降级编排——精炼失败由 AgentLoop 吞掉并退回原话，不该拖累任务本身。
        const defaultRefineInstruction: NonNullable<AgentOptions['refineInstruction']> = async (rctx) => {
          if (looksLikeSmalltalk(rctx.userInput)) return { skip: true, reason: '寒暄或极短输入，无需拆解' }
          const recent = (rctx.history ?? []).slice(-REFINE_HISTORY_TURNS)
          const historyText = recent
            .map((m) => {
              const text = typeof m.content === 'string' ? m.content : ''
              return `${m.role}: ${text.length > REFINE_NOTE_CHARS ? `${text.slice(0, REFINE_NOTE_CHARS)}…` : text}`
            })
            .filter((line) => line.trim().length > 4)
            .join('\n')
          const res = await llm.chat(
            [
              { role: 'system', content: REFINER_PROMPT },
              {
                role: 'user',
                content: historyText
                  ? `最近对话（用于消解「那个/它」这类指代）：\n${historyText}\n\n本轮用户指令：\n${rctx.userInput}`
                  : `本轮用户指令：\n${rctx.userInput}`,
              },
            ],
            { model: deps.model, temperature: 0, thinking: 'disabled', maxTokens: REFINE_MAX_TOKENS },
          )
          const text = (res.content ?? '').trim()
          if (!text) return { skip: true, reason: '精炼器没有给出任务书' }
          if (/^SKIP\b/i.test(text)) {
            const reason = text.replace(/^SKIP\s*[:：]?\s*/i, '').trim().slice(0, 80)
            return { skip: true, reason: reason || '精炼器判定无需拆解' }
          }
          if (!isStructuredBrief(text)) return { skip: true, reason: '精炼结果不成结构（缺章节或过短），退回原始指令' }
          return { instruction: text }
        }
        const baseOptions: AgentOptions = {
          systemPrompt: deps.systemPrompt,
          maxSteps: deps.maxSteps,
          // 显式下发默认模型（与 provider 自身默认相同，不改变行为）：让 agent/llm-* 事件能带上
          // gen_ai.request.model，遥测的 chat span 名与属性才有模型可写。
          model: deps.model,
          temperature: deps.temperature,
          refineInstruction: deps.refineInstruction === false ? undefined : defaultRefineInstruction,
          verifyGoal: deps.verifyGoal ?? defaultVerifyGoal,
          maxGoalVerify: deps.maxGoalVerify,
        }
        ctx.provide('agent', {
          run: async (
            userInput: string,
            sessionId?: string,
            streamOpts?: {
              onToken?: (token: string) => void
              onReasoning?: (token: string) => void
              history?: import('@zhuxing/harness-llm').ChatMessage[]
              attachments?: Array<{ type: 'image'; dataUrl: string }>
              /** 参考对话 id：注入该对话完整事件记录（重建为历史）+ 该对话私有记忆摘要作为本轮上下文。 */
              contextSessionId?: string
              /** 协作式取消信号：本层不解释它，仅随 streamOpts 并入 loopOptions 透传给 AgentLoop。 */
              signal?: AbortSignal
            },
          ) => {
            const session = sessionId ? await sessionService.get(sessionId) : await sessionService.create()
            const { AgentLoop, PlanAgent, FileTemplateStore, DEFAULT_SYSTEM_PROMPT } = await import('@zhuxing/harness-agent')
            // 上下文续接：调用方未传 history 时，从会话事件重建历史（system 由循环注入）
            let history = streamOpts?.history
            if (!history && sessionId) {
              const { buildMessagesFromEvents } = await import('@zhuxing/harness-session')
              const events = await session.events()
              history = buildMessagesFromEvents(events)
            }
            // 静态 system 保持纯净：首条 system 只含稳定指令，命中 provider 前缀缓存；
            // 记忆/参考对话/知识/skill 等每轮可能变化的动态块统一累积进 contextNotes，
            // 由 AgentLoop 作为独立 system 消息插在 history 之后、本轮用户输入之前。
            const systemPrompt = baseOptions.systemPrompt ?? DEFAULT_SYSTEM_PROMPT
            let contextNotes = ''
            // 环境索引：工作区路径、项目目录树与工作区画像最先注入，模型据此直达文件、不再探路
            contextNotes += await buildEnvironmentNotes(deps.workspace)
            // 记忆增强：运行前注入相关记忆（不替换原 prompt）
            if (memoryEnhancer) {
              contextNotes += await memoryEnhancer('', userInput)
            }
            // 参考对话上下文：指定 contextSessionId 时，注入被引用对话的上下文。
            // 交付简报优先：只注入其每次最终答复沉淀的「过程+背景」简报；无简报时才回退到完整裁剪记录。
            const contextSessionId = streamOpts?.contextSessionId
            if (contextSessionId && memoryStore) {
              try {
                const refSession = await sessionService.get(contextSessionId)
                const { buildMessagesFromEvents } = await import('@zhuxing/harness-session')
                const deliveryBriefs = (await memoryStore.list({ scope: 'session', sessionId: contextSessionId }))
                  .filter((e) => e.tags?.includes(DELIVERY_BRIEF_TAG))
                  .sort((a, b) => a.createdAt - b.createdAt)
                if (deliveryBriefs.length > 0) {
                  // 只注入最近且总量在预算内的一段：避免长对话的几十份简报全量注入
                  const shown = pickRecentBriefs(deliveryBriefs)
                  const briefBlock = [
                    '',
                    '# Referenced Conversation Delivery Briefs',
                    `You are continuing with context from another conversation (session ${contextSessionId}). ` +
                      'The following are concise delivery briefs (process & background) of that conversation; use them as background.',
                    '',
                    ...shown.map((e, i) => `## Delivery ${i + 1}\n${e.content}`),
                  ].join('\n')
                  contextNotes += briefBlock
                } else {
                  const refMessages = buildMessagesFromEvents(await refSession.events())
                  const refRecord = refMessages.length
                    ? refMessages.map(messageToContextText).filter(Boolean).join('\n')
                    : '*（该对话暂无记录）*'
                  // 防止被引用会话记录过长一次性撑爆 systemPrompt：超上限截断并标注。
                  const truncatedRef = refRecord.length > MAX_REF_CONTEXT_CHARS
                    ? `${refRecord.slice(0, MAX_REF_CONTEXT_CHARS)}\n…（参考记录过长已截断）`
                    : refRecord
                  const recordBlock = [
                    '',
                    '# Referenced Conversation Context',
                    `You are continuing with context from another conversation (session ${contextSessionId}). Use its record and private memory below as background.`,
                    '',
                    '## Conversation Record',
                    truncatedRef,
                  ].join('\n')
                  contextNotes += recordBlock
                }
                // 追加被引用对话的其它私有记忆（排除交付简报，避免与简报重复）
                contextNotes += await buildSessionMemoryPrompt(memoryStore, contextSessionId, { excludeTags: [DELIVERY_BRIEF_TAG] })('', userInput)
              } catch {
                // 被引用会话不存在或事件读取失败时忽略，保持正常对话
              }
            }
            // 知识库增强：检索相关知识块（在记忆之后、技能之前）
            if (knowledgeEnhancer) {
              contextNotes += await knowledgeEnhancer('', userInput)
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
                contextNotes += `\n\n${result.prompt}`
              } catch {
                // skill 执行失败时忽略，正常对话
              }
            }
            // G-code 编译执行模式（HARNESS_PLAN_MODE=1 开启）：模型一次编译 → 代码确定性执行，
            // 计划不可编译或节点 escalate 失败时自动回退常规 AgentLoop，行为对调用方透明。
            const loopDeps = {
              llm,
              tools,
              session,
              sandbox,
              emit: (event: string, payload?: unknown) => ctx.emit(event, payload),
              logger: ctx.logger,
            }
            const notes = contextNotes.trim()
            const loopOptions = { ...baseOptions, systemPrompt, ...(notes ? { contextNotes: notes } : {}), ...(streamOpts ?? {}) }
            // 模板库与记忆文件同目录：成功流程沉淀为参数化模板，下次同类请求只输出「模板id+参数」即可执行
            const loop = process.env.HARNESS_PLAN_MODE === '1'
              ? new PlanAgent(loopDeps, {
                  ...loopOptions,
                  templates: new FileTemplateStore(join(dirname(deps.memoryPath ?? defaultMemoryPath()), 'gcode-templates.json')),
                })
              : new AgentLoop(loopDeps, loopOptions)
            const result = await loop.run(userInput, history)
            // 交付简报沉淀：每次最终答复（finishedReason=stop）自动生成一份简要「过程+背景」说明，
            // 写入会话私有记忆，供后续「参考对话注入」优先使用（失败不阻断对话）。
            if (memoryStore && result.finishedReason === 'stop' && result.content.trim()) {
              try {
                const events = await session.events()
                const brief = buildDeliveryBrief(userInput, result, events)
                await memoryStore.add({ scope: 'session', sessionId: session.id, content: brief, tags: [DELIVERY_BRIEF_TAG] })
                // 同一会话只保留最近若干份简报：注入时也只看最近几份，旧简报没有留存价值
                const stale = (await memoryStore.list({ scope: 'session', sessionId: session.id }))
                  .filter((e) => e.tags?.includes(DELIVERY_BRIEF_TAG))
                  .sort((a, b) => b.createdAt - a.createdAt)
                  .slice(MAX_SESSION_BRIEFS)
                for (const e of stale) await memoryStore.remove(e.id)
              } catch {
                // 简报沉淀失败时忽略，保持正常对话
              }
            }
            return result
          },
        })
      },
    },
  ]
}
