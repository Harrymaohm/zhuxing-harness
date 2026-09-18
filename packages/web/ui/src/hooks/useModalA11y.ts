import { useEffect, useRef } from 'react'

/** 弹窗内可 Tab 到的元素：排除禁用控件与 tabindex="-1"（那类只能被脚本聚焦）。 */
const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ')

/**
 * 弹窗可达性：Esc 关闭、打开时移入焦点、Tab 在弹窗内循环、关闭后把焦点还给触发元素。
 * 返回的 ref 需要挂到弹窗容器上（容器需带 tabIndex={-1}）。
 *
 * 为什么自己写焦点陷阱：`aria-modal` 只让辅助技术忽略弹窗背后的内容，
 * 浏览器原生的 Tab 顺序并不受它约束——不加拦截，键盘用户会一路 Tab 到背后的侧栏按钮。
 */
export function useModalA11y(open: boolean, onClose: () => void) {
  const ref = useRef<HTMLDivElement | null>(null)
  const openerRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (!open) return
    openerRef.current = document.activeElement as HTMLElement | null
    ref.current?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
        return
      }
      if (e.key !== 'Tab') return
      const root = ref.current
      if (!root) return
      // 焦点已在别的弹窗里就不插手：设置面板与文件预览可能同时挂着，
      // 两个陷阱都动手会把 Tab 在弹窗之间来回弹。
      const active = document.activeElement as HTMLElement | null
      if (!active || !root.contains(active)) return
      // 弹窗内没有任何可聚焦元素（纯文本弹窗）：把 Tab 收在容器上，别漏到背后
      const items = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE))
      if (items.length === 0) {
        e.preventDefault()
        root.focus()
        return
      }
      const first = items[0]
      const last = items[items.length - 1]
      // 初始焦点落在容器自身上：不接住的话 Shift+Tab 会退到弹窗背后
      if (active === root) {
        e.preventDefault()
        ;(e.shiftKey ? last : first).focus()
        return
      }
      if (e.shiftKey && active === first) {
        e.preventDefault()
        last.focus()
        return
      }
      if (!e.shiftKey && active === last) {
        e.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
      openerRef.current?.focus?.()
    }
  }, [open, onClose])

  return ref
}
