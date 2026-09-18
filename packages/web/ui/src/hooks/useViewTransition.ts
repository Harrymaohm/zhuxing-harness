import { useCallback } from 'react'
import { flushSync } from 'react-dom'

/** 形变时挂到 <html data-overlay> 上的目标名，供 CSS 指定共享元素。 */
export type MorphTarget = 'settings' | 'knowledge' | 'preview' | 'subchat'

type DocumentWithViewTransition = Document & {
  startViewTransition?: (callback: () => void) => { finished: Promise<void> }
}

function prefersReducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

/**
 * 形态变换入口：把一次状态更新包进 View Transition，让「侧栏按钮 → 浮层面板」
 * 这类共享元素以同一形态连续过渡，而不是一个消失、另一个出现。
 *
 * 降级策略（都不影响功能，只影响是否播放动画）：
 * - 浏览器不支持 startViewTransition：同步执行更新。
 * - 系统开启「减少动态效果」：同步执行更新。
 *
 * `target` 会在新快照生成前写入 <html data-overlay>，CSS 据此把
 * view-transition-name 从触发按钮转移到面板上；动画结束后清除。
 */
export function useViewTransition() {
  return useCallback((update: () => void, target?: MorphTarget) => {
    const doc = document as DocumentWithViewTransition
    if (prefersReducedMotion() || typeof doc.startViewTransition !== 'function') {
      update()
      return
    }
    const root = document.documentElement
    const transition = doc.startViewTransition(() => {
      // flushSync 保证 React 的 DOM 更新在本帧内落地，新快照才能捕捉到最终形态。
      flushSync(() => {
        if (target) root.dataset.overlay = target
        update()
      })
    })
    void transition.finished.finally(() => {
      delete root.dataset.overlay
    })
  }, [])
}
