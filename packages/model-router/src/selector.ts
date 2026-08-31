import type { ChatMessage } from '@zhuxing/harness-llm'
import type { ModelCapability, ModelChoice, ModelMonitor, ModelRegistry, SelectOptions, SelectorConfig } from './types.js'

/** 预置意图词表：能力标签 -> 触发关键词（中英）。用于任务需求分析。 */
const INTENT_KEYWORDS: Record<ModelCapability, string[]> = {
  code: [
    '代码', '编码', '函数', '脚本', '实现', '重构', '调试', '修复', 'bug', '报错',
    '编程', '写一个', '写段', 'npm', 'git', 'typescript', 'python', 'javascript',
    'code', 'coding', 'function', 'script', 'refactor', 'debug', 'implement', 'compile',
  ],
  reasoning: [
    '推理', '逻辑', '推导', '数学', '证明', '分析', '为什么', '如何', '比较', '判断',
    '解方程', '规划', '策略',
    'reason', 'logic', 'math', 'proof', 'why', 'how', 'compare', 'deduce', 'plan',
  ],
  creative: [
    '创意', '写作', '文案', '故事', '诗歌', '改写', '润色', '标题', '广告', '文案',
    'creative', 'write', 'story', 'poem', 'rewrite', 'polish', 'headline', 'copy',
  ],
  analysis: [
    '总结', '摘要', '分析报告', '统计', '趋势', '结构化', '提取', '汇总', '评估',
    'summarize', 'summary', 'analyze', 'stats', 'trend', 'extract', 'evaluate', 'review',
  ],
  fast: [
    '快点', '快速', '简答', '简要', '一句话', '快速回复',
    'quick', 'fast', 'short', 'brief', 'concise',
  ],
  cheap: ['省钱', '低成本', '便宜', 'cheap', 'low cost', 'budget'],
  'long-context': [
    '长文档', '整个仓库', '全部文件', '长文本', '整本',
    'long', 'whole repo', 'entire', 'full document',
  ],
  vision: [
    '看图', '图片', '识别图片', '截图', '照片', '图像', 'OCR', '读图',
    'image', 'picture', 'photo', 'screenshot', 'vision', 'ocr',
  ],
  general: [],
}

/** 任务意图分析：统计输入文本命中各能力的关键词次数。 */
function analyzeIntents(task: string): Map<ModelCapability, number> {
  const text = task.toLowerCase()
  const hits = new Map<ModelCapability, number>()
  for (const [capability, keywords] of Object.entries(INTENT_KEYWORDS)) {
    let count = 0
    for (const kw of keywords) {
      const needle = kw.toLowerCase()
      if (text.includes(needle)) count += 1
    }
    if (count > 0) hits.set(capability as ModelCapability, count)
  }
  return hits
}

/** 从消息序列提取用户任务文本（最后一条 user 消息 + 之前的 user 消息拼接）。 */
export function taskTextFromMessages(messages: ChatMessage[]): string {
  return messages
    .filter((m) => m.role === 'user')
    .map((m) => m.content)
    .join('\n')
}

/** 模型选择算法：基于任务需求（意图）、上下文长度、实时性能指标评分排序。 */
export class ModelSelectorImpl {
  private capabilityWeight: number
  private contextWeight: number
  private performanceWeight: number
  private minScore: number
  private maxResults: number

  constructor(
    private registry: ModelRegistry,
    private monitor: ModelMonitor,
    config: SelectorConfig = {},
  ) {
    this.capabilityWeight = config.capabilityWeight ?? 0.5
    this.contextWeight = config.contextWeight ?? 0.2
    this.performanceWeight = config.performanceWeight ?? 0.3
    this.minScore = config.minScore ?? 0.15
    this.maxResults = config.maxResults ?? 8
  }

  /** 选择候选：按评分降序。显式 modelId 置顶且不参与评分。 */
  select(messages: ChatMessage[], options: SelectOptions = {}): ModelChoice[] {
    const models = this.registry.list()
    if (models.length === 0) return []

    // 显式指定：直接返回该模型（未注册时降级为自动选择）
    if (options.modelId && this.registry.has(options.modelId)) {
      return [{ modelId: options.modelId, score: 1, breakdown: { capability: 1, context: 1, performance: 1 } }]
    }

    const task = options.task ?? taskTextFromMessages(messages)
    const intents = analyzeIntents(task)
    const contextChars = task.length
    const preferredCaps = new Set<ModelCapability>(options.capabilities ?? [])

    const choices: ModelChoice[] = models
      .map(({ spec }) => {
        const breakdown = {
          capability: this.capabilityScore(spec.capabilities ?? [], intents, preferredCaps),
          context: this.contextScore(spec.contextWindow, contextChars),
          performance: this.performanceScore(spec.id),
        }
        const score =
          breakdown.capability * this.capabilityWeight +
          breakdown.context * this.contextWeight +
          breakdown.performance * this.performanceWeight
        return { modelId: spec.id, score: Number(score.toFixed(4)), breakdown }
      })
      .filter((c) => c.score >= this.minScore)
      .sort((a, b) => b.score - a.score)

    return choices.slice(0, this.maxResults)
  }

  /** 能力匹配：命中的意图能力在模型能力中的覆盖率 + 显式偏好加分。0..1。 */
  private capabilityScore(
    caps: ModelCapability[],
    intents: Map<ModelCapability, number>,
    preferred: Set<ModelCapability>,
  ): number {
    let score = 0
    // 显式能力偏好：模型具备偏好的能力则给基础分
    if (preferred.size > 0) {
      const covered = [...preferred].filter((p) => caps.includes(p)).length
      score += covered / preferred.size
    } else {
      // 通用兜底：无明确意图时模型至少有通用能力视为 0.5
      score += 0.5
    }
    // 意图命中匹配
    if (intents.size > 0) {
      let matched = 0
      for (const [intent, weight] of intents) {
        if (caps.includes(intent)) matched += weight
      }
      const totalWeight = [...intents.values()].reduce((s, v) => s + v, 0)
      score += (matched / totalWeight) * 0.5
    }
    return Math.min(1, score)
  }

  /** 上下文适配：字符数估算 token（约 2.5 字符/token），超过窗口降低得分。0..1。 */
  private contextScore(contextWindow: number | undefined, contextChars: number): number {
    if (!contextWindow || contextWindow <= 0) return 0.8
    const estTokens = Math.ceil(contextChars / 2.5)
    if (estTokens <= contextWindow) return 1
    const ratio = contextWindow / estTokens
    // 超出越多衰减越狠，最低 0.05
    return Math.max(0.05, ratio * ratio)
  }

  /** 性能评分：基于监控窗口的成功率与延迟。0..1。无数据时取 0.6 中性分。 */
  private performanceScore(modelId: string): number {
    const m = this.monitor.metrics(modelId)
    if (m.calls === 0) return 0.6
    const success = m.successRate
    // 延迟归一化：>30s 得 0，<=1s 得 1
    const latencyScore = Math.max(0, Math.min(1, 1 - m.avgLatencyMs / 30_000))
    return Number((0.7 * success + 0.3 * latencyScore).toFixed(4))
  }
}
