import type { JSX } from 'react'

/**
 * 内联 SVG 图标集。
 * 统一 24×24 画布、1.5px 等宽描边、圆角端点，颜色继承 currentColor，
 * 因此两套主题自动成立，且不产生任何网络请求。
 */
export type IconName =
  | 'file'
  | 'folder'
  | 'folder-open'
  | 'archive'
  | 'book'
  | 'sliders'
  | 'image'
  | 'terminal'
  | 'package'
  | 'sparkle'
  | 'document'
  | 'upload'
  | 'download'
  | 'search'
  | 'close'
  | 'check'
  | 'alert'
  | 'stop'
  | 'trash'
  | 'undo'
  | 'branch'
  | 'merge'
  | 'sun'
  | 'moon'
  | 'refresh'
  | 'chevron-down'
  | 'chevron-right'
  | 'chevron-left'
  | 'plus'
  | 'play'
  | 'list'
  | 'graph'
  | 'arrow-left'
  | 'external'
  | 'paperclip'

const PATHS: Record<IconName, JSX.Element> = {
  file: (
    <>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M14 3v5h5" />
    </>
  ),
  folder: <path d="M3 7a2 2 0 0 1 2-2h3.6l2 2H19a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />,
  'folder-open': (
    <>
      <path d="M3 7a2 2 0 0 1 2-2h3.6l2 2H19a2 2 0 0 1 2 2v1" />
      <path d="M3 9.5V18a1 1 0 0 0 1 1h15l2-8H5a2 2 0 0 0-2 2z" />
    </>
  ),
  archive: (
    <>
      <path d="M4 4h16v4H4z" />
      <path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8" />
      <path d="M10 12h4" />
    </>
  ),
  book: (
    <>
      <path d="M12 7.5C10.5 6 8.5 5.5 6 5.5v12c2.5 0 4.5.5 6 2 1.5-1.5 3.5-2 6-2v-12c-2.5 0-4.5.5-6 2z" />
      <path d="M12 7.5v12" />
    </>
  ),
  sliders: (
    <>
      <path d="M4 8h20" />
      <path d="M4 16h20" />
      <circle cx="9" cy="8" r="2.4" />
      <circle cx="15" cy="16" r="2.4" />
    </>
  ),
  image: (
    <>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <circle cx="8.5" cy="10" r="1.5" />
      <path d="M3 16.5l4.5-4.5 3.5 3.5 3-3L21 16.5" />
    </>
  ),
  terminal: (
    <>
      <path d="M5 7l4.5 4.5L5 16" />
      <path d="M12.5 17h6.5" />
    </>
  ),
  package: (
    <>
      <path d="M12 3l9 4.8-9 4.8-9-4.8z" />
      <path d="M3 7.8v8.4l9 4.8 9-4.8V7.8" />
      <path d="M12 12.6V21" />
    </>
  ),
  sparkle: (
    <>
      <path d="M11 3.5l1.7 4.3 4.3 1.7-4.3 1.7L11 15.5 9.3 11.2 5 9.5l4.3-1.7z" />
      <path d="M18.5 15l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z" />
    </>
  ),
  document: (
    <>
      <path d="M13.5 3H8a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7.5z" />
      <path d="M13.5 3v4.5H18" />
      <path d="M9 13h6M9 16.5h4" />
    </>
  ),
  upload: (
    <>
      <path d="M12 16V4" />
      <path d="M7.5 8.5L12 4l4.5 4.5" />
      <path d="M4 16v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
    </>
  ),
  download: (
    <>
      <path d="M12 4v12" />
      <path d="M7.5 11.5L12 16l4.5-4.5" />
      <path d="M4 16v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="M20.5 20.5L16 16" />
    </>
  ),
  close: (
    <>
      <path d="M6.5 6.5l11 11" />
      <path d="M17.5 6.5l-11 11" />
    </>
  ),
  check: <path d="M5 12.5l4.5 4.5L19 7" />,
  alert: (
    <>
      <path d="M12 4l8.5 15H3.5z" />
      <path d="M12 9.5v4" />
      <path d="M12 16.6h.01" />
    </>
  ),
  stop: <rect x="6.5" y="6.5" width="11" height="11" rx="1.5" />,
  trash: (
    <>
      <path d="M4 7h16" />
      <path d="M9.5 7V5h5v2" />
      <path d="M6.5 7l.9 12a1 1 0 0 0 1 1h7.2a1 1 0 0 0 1-1l.9-12" />
      <path d="M10.5 11v5M13.5 11v5" />
    </>
  ),
  undo: (
    <>
      <path d="M4 10h9a5 5 0 0 1 0 10H9" />
      <path d="M4 10l4-4" />
      <path d="M4 10l4 4" />
    </>
  ),
  branch: (
    <>
      <circle cx="6.5" cy="5.5" r="2" />
      <circle cx="6.5" cy="18.5" r="2" />
      <circle cx="17.5" cy="12" r="2" />
      <path d="M6.5 7.5v9" />
      <path d="M17.5 10v-1.5a2 2 0 0 0-2-2h-4" />
    </>
  ),
  merge: (
    <>
      <circle cx="6.5" cy="5.5" r="2" />
      <circle cx="6.5" cy="18.5" r="2" />
      <circle cx="17.5" cy="12" r="2" />
      <path d="M6.5 7.5v9" />
      <path d="M8.5 17.5h4a3 3 0 0 0 3-3V14" />
    </>
  ),
  sun: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M18.4 5.6L17 7M7 17l-1.4 1.4" />
    </>
  ),
  moon: <path d="M20.5 13.2A8.5 8.5 0 1 1 10.8 3.5a7 7 0 0 0 9.7 9.7z" />,
  refresh: (
    <>
      <path d="M20 12a8 8 0 1 1-2.4-5.7" />
      <path d="M20.5 4.5V10h-5.5" />
    </>
  ),
  'chevron-down': <path d="M6.5 9.5l5.5 5.5 5.5-5.5" />,
  'chevron-right': <path d="M9.5 6.5l5.5 5.5-5.5 5.5" />,
  'chevron-left': <path d="M14.5 6.5L9 12l5.5 5.5" />,
  plus: (
    <>
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </>
  ),
  play: <path d="M7.5 5l11 7-11 7z" />,
  list: (
    <>
      <path d="M4 7h16M4 12h16M4 17h16" />
    </>
  ),
  graph: (
    <>
      <circle cx="6" cy="7" r="2.2" />
      <circle cx="18" cy="7" r="2.2" />
      <circle cx="12" cy="18" r="2.2" />
      <path d="M7.9 8.4L10.5 16M16.1 8.4L13.5 16M8.2 7h7.6" />
    </>
  ),
  'arrow-left': (
    <>
      <path d="M19 12H5" />
      <path d="M11 6l-6 6 6 6" />
    </>
  ),
  external: (
    <>
      <path d="M14 4h6v6" />
      <path d="M20 4l-8.5 8.5" />
      <path d="M18 14.5V19a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h4.5" />
    </>
  ),
  paperclip: (
    <path d="M20 11.5l-8.4 8.4a4.7 4.7 0 0 1-6.6-6.6l8.4-8.4a3.2 3.2 0 0 1 4.5 4.5l-8.4 8.4a1.6 1.6 0 0 1-2.3-2.3L15 7.5" />
  ),
}

export function Icon({
  name,
  size = 16,
  className,
}: {
  name: IconName
  size?: number
  className?: string
}) {
  return (
    <svg
      className={className ? `icon ${className}` : 'icon'}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[name]}
    </svg>
  )
}
