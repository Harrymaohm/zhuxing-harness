import type { ChatMessage } from '../types'

/** 把「如何写回一条助手消息」抽象出来，便于单测时直接计数。 */
export type PatchAssistant = (fn: (m: ChatMessage) => ChatMessage) => void

/**
 * 正文的合并窗口（毫秒）。
 *
 * 模型每秒能吐几十个 token；逐条写回等于把整个消息数组复制几十次、让根组件连同会话树
 * 重算几十遍，一个长回答下来就是几千轮全量重渲染。合并到约 4 帧写一次，打字机观感几乎无差别。
 */
export const STREAM_TOKEN_FLUSH_MS = 60

/**
 * 思考的合并窗口（毫秒）。
 *
 * 「临时说明」默认是收起的——用户根本看不见，却要付全部渲染成本，所以窗口比正文更粗
 * （约 9 帧一次）。收尾路径会强制 flush，不会丢最后一段。
 */
export const STREAM_THINK_FLUSH_MS = 150

/**
 * 流式事件的增量缓冲。
 *
 * 从 App.tsx 里搬出来单独成模块的原因：这条路径是长回答卡顿的源头，却因为写在 2400 行的
 * 组件内部而**完全无法单测**——「每个 token 触发一次渲染」这种回归没有任何测试拦得住。
 * 搬出来之后可以用假定时器确定性地数「N 个 token 到底触发了多少次写回」。
 */
export class StreamBuffer {
  /** 本步已产出的正文：同步累积，供「调用工具 → 撤回成思考」的归类判断。 */
  private cur = ''
  /** 待合并上屏的正文增量。 */
  private pendingToken = ''
  /** 待合并写回的思考增量。 */
  private pendingThink = ''
  private tokenTimer: number | null = null
  private thinkTimer: number | null = null

  /** 本步已产出的正文（只读）。 */
  get curContent(): string {
    return this.cur
  }

  /** 新一步开始：本步的正文缓冲清零（上屏侧不受影响）。 */
  nextStep(): void {
    this.cur = ''
  }

  /**
   * 收到一段正文增量。
   *
   * `cur` 必须**同步**累积而不能等定时器：工具撤回判定读的就是它。
   * 上屏则走合并窗口。
   */
  pushToken(text: string, patch: PatchAssistant): void {
    this.cur += text
    this.pendingToken += text
    if (this.tokenTimer === null) {
      this.tokenTimer = window.setTimeout(() => {
        this.tokenTimer = null
        this.flushTokens(patch)
      }, STREAM_TOKEN_FLUSH_MS)
    }
  }

  /** 收到一段思考增量（合并窗口内累积，到点一次性写回）。 */
  pushThinking(text: string, patch: PatchAssistant): void {
    this.pendingThink += text
    if (this.thinkTimer === null) {
      this.thinkTimer = window.setTimeout(() => {
        this.thinkTimer = null
        this.flushThinking(patch)
      }, STREAM_THINK_FLUSH_MS)
    }
  }

  /**
   * 立刻把待上屏的正文写回。
   *
   * 撤回（工具调用前）、收尾（result / error / 异常）路径必须调用：
   * 前者依赖消息正文以本步正文结尾才能算准撤回位置，后者不调用就会丢字。
   */
  flushTokens(patch: PatchAssistant): void {
    if (this.tokenTimer !== null) {
      window.clearTimeout(this.tokenTimer)
      this.tokenTimer = null
    }
    const chunk = this.pendingToken
    this.pendingToken = ''
    if (chunk) patch((m) => ({ ...m, content: `${m.content ?? ''}${chunk}` }))
  }

  /** 立刻把待写回的思考落盘（同上，收尾路径必须调用）。 */
  flushThinking(patch: PatchAssistant): void {
    if (this.thinkTimer !== null) {
      window.clearTimeout(this.thinkTimer)
      this.thinkTimer = null
    }
    const chunk = this.pendingThink
    this.pendingThink = ''
    if (chunk) patch((m) => ({ ...m, thinking: `${m.thinking ?? ''}${chunk}` }))
  }

  /** 取走本步正文并清空（工具调用前撤回用）。 */
  takeCurContent(): string {
    const desc = this.cur
    this.cur = ''
    return desc
  }
}
