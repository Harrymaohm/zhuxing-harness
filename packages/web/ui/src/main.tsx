import React from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { ErrorBoundary } from './components/ErrorBoundary'
import { VersionBanner } from './components/VersionBanner'
import './style.css'

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
      {/* 版本不一致提示：挂在 App 之外，不侵入主界面 */}
      <VersionBanner />
    </ErrorBoundary>
  </React.StrictMode>,
)
