import { useEffect, useState } from 'react'

import { initAccessToken, versionMismatch } from '../api'
import './version-banner.css'

const DISMISS_KEY = 'harness.ui-version-notice-dismissed'

/**
 * 界面版本与服务端版本不一致时的提示条。
 *
 * 场景：应用更新后服务端已换新内核，但浏览器标签页还捧着旧的前端包，
 * 表现就是「界面看着是新的、行为却是旧的」——最难排查的一类问题。
 *
 * 刻意做成**非阻塞提示**而不是自动刷新：自动刷新会在版本注入缺失等异常情形下
 * 变成反复重载，把一个小问题放大成不可用。刷新与否交给用户决定。
 */
export function VersionBanner() {
  const [mismatch, setMismatch] = useState<{ ui: string; server: string } | null>(null)

  useEffect(() => {
    let alive = true
    void initAccessToken().then(() => {
      if (!alive) return
      let dismissed = false
      try {
        dismissed = window.sessionStorage.getItem(DISMISS_KEY) === '1'
      } catch {
        /* 隐私模式下 sessionStorage 可能不可用，按未忽略处理 */
      }
      if (!dismissed) setMismatch(versionMismatch())
    })
    return () => {
      alive = false
    }
  }, [])

  if (!mismatch) return null

  const dismiss = () => {
    try {
      window.sessionStorage.setItem(DISMISS_KEY, '1')
    } catch {
      /* ignore */
    }
    setMismatch(null)
  }

  return (
    <div className="vb-bar" role="status">
      <span className="vb-text">
        界面版本 <b>v{mismatch.ui}</b> 与服务端 <b>v{mismatch.server}</b> 不一致，当前可能仍在运行旧界面。
      </span>
      <span className="vb-actions">
        <button className="vb-btn vb-primary" onClick={() => window.location.reload()}>
          刷新页面
        </button>
        <button className="vb-btn" onClick={dismiss}>
          忽略
        </button>
      </span>
    </div>
  )
}
