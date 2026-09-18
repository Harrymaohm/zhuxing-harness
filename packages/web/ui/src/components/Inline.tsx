/**
 * 就地状态的两个基础呈现（列表/面板级等待与错误）。
 *
 * 单独成文件是因为它们被主界面与懒加载的文件预览共用——留在 App.tsx 里会把
 * 预览块钉死在首屏 chunk，失去按需加载的意义。
 */
import { Icon } from './Icon'

/**
 * 列表/面板级等待的唯一呈现：文字 + spinner。
 *
 * 只覆盖「整块区域在等数据」的场景——按钮触发的等待用按钮文案表达（离操作点最近），
 * 消息区流式等待用骨架屏（表达「内容正在长出来」），两者刻意不走这里。
 * 文案默认「加载中…」，仅预览文件内容时传「读取中…」以区分「读文件」与「等接口」。
 */
export function InlineLoading({ text = '加载中…' }: { text?: string }) {
  return (
    <span className="inline-loading" role="status">
      <span className="inline-loading-spinner" aria-hidden="true" />
      {text}
    </span>
  )
}

/**
 * 面板/列表级就地错误的唯一呈现。
 *
 * 只有「失败与某块界面绑定、用户必须站在原地看到」时才用它；
 * 保存/删除/安装这类一次性动作的失败一律走 toast，避免错误提示飘在离操作点很远的地方。
 */
export function InlineError({ children }: { children: React.ReactNode }) {
  return (
    <div className="error-banner" role="alert">
      <Icon name="alert" /> {children}
    </div>
  )
}
