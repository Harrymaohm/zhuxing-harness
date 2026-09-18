import { Component, type ErrorInfo, type ReactNode } from 'react'

/**
 * 渲染期异常兜底。
 *
 * 存在的理由：React 在渲染阶段抛错时会**卸载整棵树**，页面直接变白，
 * 而且控制台之外没有任何提示——用户看到的「网页突然不再渲染」大多就是这么来的。
 * 有了这层兜底，单个组件出错只会退化成一块错误面板，其余界面与数据都还在。
 *
 * 样式刻意写成内联：兜底面必须在样式表本身出问题时也还能看。
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null; showStack: boolean }> {
  state: { error: Error | null; showStack: boolean } = { error: null, showStack: false }

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // 留在控制台便于定位；这是渲染崩溃，不是可忽略的告警
    console.error('[harness] 界面渲染异常', error, info.componentStack)
  }

  render(): ReactNode {
    const { error } = this.state
    if (!error) return this.props.children
    return (
      <div
        style={{
          minHeight: '100vh',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 12,
          padding: 32,
          fontFamily: 'system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif',
          color: '#e8edf2',
          background: '#07090d',
          textAlign: 'center',
        }}
      >
        <div style={{ fontSize: 15, fontWeight: 600 }}>界面渲染出错，已中断本次渲染</div>
        <div style={{ fontSize: 13, color: '#98a4b3', maxWidth: 560, lineHeight: 1.7 }}>
          页面没有崩溃，会话记录也还在。可以先点「重试渲染」；若仍失败，展开下面的技术细节去提问题。
        </div>
        <code
          style={{
            maxWidth: 720,
            padding: '8px 12px',
            borderRadius: 8,
            background: '#141a24',
            color: '#ff5c5c',
            fontSize: 12,
            wordBreak: 'break-all',
          }}
        >
          {error.message}
        </code>
        <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
          <button
            onClick={() => this.setState({ error: null })}
            style={{ padding: '6px 14px', borderRadius: 8, border: '1px solid #35e0f2', background: 'rgba(53,224,242,0.12)', color: '#35e0f2', fontSize: 13, cursor: 'pointer' }}
          >
            重试渲染
          </button>
          <button
            onClick={() => window.location.reload()}
            style={{ padding: '6px 14px', borderRadius: 8, border: '1px solid rgba(255,255,255,0.16)', background: 'transparent', color: '#98a4b3', fontSize: 13, cursor: 'pointer' }}
          >
            重新加载页面
          </button>
        </div>
        {error.stack && (
          <div style={{ marginTop: 8, maxWidth: 720, textAlign: 'left' }}>
            {/* 原生 <details> 的展开语义与界面其它折叠块不一致：统一成可聚焦按钮 + aria-expanded */}
            <button
              onClick={() => this.setState((prev) => ({ showStack: !prev.showStack }))}
              aria-expanded={this.state.showStack}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                padding: 0,
                border: 0,
                background: 'transparent',
                fontFamily: 'inherit',
                fontSize: 12,
                color: '#6f7c8c',
                cursor: 'pointer',
              }}
            >
              <span style={{ opacity: 0.6 }}>{this.state.showStack ? '▾' : '▸'}</span>
              {this.state.showStack ? '收起技术细节' : '技术细节'}
            </button>
            {this.state.showStack && (
              <pre style={{ marginTop: 8, padding: 12, borderRadius: 8, background: '#0e121a', color: '#98a4b3', fontSize: 11, overflow: 'auto', maxHeight: 240 }}>
                {error.stack}
              </pre>
            )}
          </div>
        )}
      </div>
    )
  }
}
