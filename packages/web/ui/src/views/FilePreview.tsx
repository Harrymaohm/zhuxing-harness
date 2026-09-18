/**
 * 文件预览弹窗：文本 / PDF / docx / xlsx / pptx。
 *
 * 单独成文件并按需加载的原因：docx 走 mammoth、表格走 SheetJS、ppt 走 pptx-wasm（外加一个
 * 700KB+ 的 wasm 资源）。这四者只在用户真的点开预览时才有用，钉在首屏 chunk 里等于让所有人都
 * 先下载一遍。导出为命名导出，由 App 侧 `lazy()` 包装。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import mammoth from 'mammoth'
import * as XLSX from 'xlsx'
import { PresentationViewer, type PresentationViewerHandle } from 'pptx-wasm/react'
import pptxWasmUrl from 'pptx-wasm/wasm?url'
import { apiFetch } from '../api'
import { Icon } from '../components/Icon'
import { useModalA11y } from '../hooks/useModalA11y'
import { InlineLoading } from '../components/Inline'

function escapeHtml(str: string): string {
  return str.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string))
}

/** 清除上传文件可能携带的脚本/事件属性，本地工具仍按不可信输入处理。 */
function sanitizeOfficeHtml(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  doc.querySelectorAll('script,style,iframe,object,embed,link,meta,base').forEach((el) => el.remove())
  doc.querySelectorAll('*').forEach((el) => {
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase()
      if (name.startsWith('on')) el.removeAttribute(attr.name)
      else if ((name === 'href' || name === 'src' || name === 'xlink:href') && /^\s*javascript:/i.test(attr.value)) el.removeAttribute(attr.name)
      else if (name === 'data-v' || name === 'data-t' || name === 'id') el.removeAttribute(attr.name)
    }
  })
  return doc.body.innerHTML
}

/** 文本预览：带 `path:line` 定位时渲染行号并高亮目标行、自动滚动到该行。
 *  超长文件（>3000 行）退回纯文本渲染，避免为定位付出大量 DOM 节点。 */
function TextPreview({ content, line }: { content: string; line?: number }) {
  const hitRef = useRef<HTMLDivElement | null>(null)
  const lines = useMemo(() => (line ? content.split('\n') : []), [content, line])

  useEffect(() => {
    if (line && hitRef.current) hitRef.current.scrollIntoView({ block: 'center' })
  }, [line, content])

  if (!content) return <div className="file-preview-content"><InlineLoading text="读取中…" /></div>
  if (!line || lines.length > 3000) return <pre className="file-preview-content">{content}</pre>

  return (
    <div className="file-preview-content code-lines">
      {lines.map((text, i) => {
        const no = i + 1
        const hit = no === line
        return (
          <div
            key={no}
            ref={hit ? hitRef : undefined}
            className={`code-line${hit ? ' hit' : ''}`}
            data-line={no}
          >
            {text || ' '}
          </div>
        )
      })}
    </div>
  )
}

export function FilePreview({ path, line, onClose }: { path: string; line?: number; onClose: () => void }) {
  const [content, setContent] = useState('')
  const [error, setError] = useState('')
  const [pdfUrl, setPdfUrl] = useState<string | null>(null)
  const [officeSheets, setOfficeSheets] = useState<Array<{ name: string; html: string }>>([])
  const [pptxFile, setPptxFile] = useState<Blob | null>(null)
  const [pptxCount, setPptxCount] = useState(0)
  const [pptxIndex, setPptxIndex] = useState(0)
  const pptxRef = useRef<PresentationViewerHandle | null>(null)
  const isPdf = /\.pdf$/i.test(path)
  const isDocx = /\.docx$/i.test(path)
  const isXlsx = /\.(xlsx|xls)$/i.test(path)
  const isPptx = /\.pptx$/i.test(path)
  const isBinary = isPdf || isDocx || isXlsx || isPptx
  const isText = !isBinary

  // 本弹窗「挂载即打开」；包一层稳定引用，避免 Esc 监听与焦点还原被反复重绑。
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  const closeModal = useCallback(() => onCloseRef.current(), [])
  const modalRef = useModalA11y(true, closeModal)

  useEffect(() => {
    let cancelled = false
    setContent('')
    setError('')
    setPdfUrl(null)
    setOfficeSheets([])
    setPptxFile(null)
    setPptxCount(0)
    setPptxIndex(0)
    if (isText) {
      void apiFetch(`/api/files/preview?path=${encodeURIComponent(path)}`)
        .then(async (res) => {
          const data = (await res.json()) as { content?: string; error?: string }
          if (!res.ok) throw new Error(data.error ?? `预览失败（HTTP ${res.status}）`)
          if (!cancelled) setContent(data.content ?? '')
        })
        .catch((err: unknown) => {
          if (!cancelled) setError(err instanceof Error ? err.message : String(err))
        })
      return () => { cancelled = true }
    }
    // 二进制格式：先经 raw=1 获取原始字节，再按扩展名在浏览器端渲染
    void apiFetch(`/api/files/preview?path=${encodeURIComponent(path)}&raw=1`)
      .then(async (res) => {
        if (!res.ok) {
          const data = (await res.json().catch(() => ({}))) as { error?: string }
          throw new Error(data.error ?? `预览失败（HTTP ${res.status}）`)
        }
        const blob = await res.blob()
        if (cancelled) return
        if (isPdf) {
          setPdfUrl(URL.createObjectURL(blob))
          return
        }
        if (isPptx) {
          setPptxFile(blob)
          return
        }
        const arrayBuffer = await blob.arrayBuffer()
        if (isDocx) {
          // mammoth 浏览器端 .docx → 安全的 HTML
          const result = await mammoth.convertToHtml({ arrayBuffer })
          if (!cancelled) setOfficeSheets([{ name: '', html: sanitizeOfficeHtml(result.value) }])
          return
        }
        if (isXlsx) {
          // SheetJS 读取 .xlsx/.xls → 逐工作表转 HTML 表格
          const wb = XLSX.read(arrayBuffer, { type: 'array' })
          const sheets = wb.SheetNames.map((name) => {
            const ws = wb.Sheets[name]
            const table = (XLSX.utils.sheet_to_html(ws).match(/<table[\s\S]*<\/table>/i)?.[0]) ?? ''
            return { name, html: sanitizeOfficeHtml(table) }
          })
          if (!cancelled) setOfficeSheets(sheets)
          return
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      })
    return () => { cancelled = true }
  }, [path, isPdf, isDocx, isXlsx, isPptx, isText])

  useEffect(() => {
    return () => {
      if (pdfUrl) URL.revokeObjectURL(pdfUrl)
    }
  }, [pdfUrl])

  return (
    <div className="modal-mask" onClick={onClose}>
      <div
        className="modal file-preview-modal"
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-label="文件预览"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation()
            closeModal()
          }
        }}
      >
        <div className="file-preview-head">
          <strong>{path}{line ? ` · 第 ${line} 行` : ''}</strong>
          <button className="btn-link" onClick={closeModal}>关闭</button>
        </div>
        {error ? (
          <div className="error-banner" role="alert"><Icon name="alert" /> {error}</div>
        ) : isPdf && pdfUrl ? (
          <iframe title="PDF 预览" src={pdfUrl} className="pdf-frame" />
        ) : isPptx && pptxFile ? (
          <div className="office-frame">
            <div className="ppt-toolbar">
              <button className="btn-link ppt-nav" disabled={pptxIndex <= 0} onClick={() => pptxRef.current?.previous()} title="上一页"><Icon name="chevron-left" /> 上一页</button>
              <span className="ppt-counter">{pptxCount > 0 ? `第 ${pptxIndex + 1} / ${pptxCount} 页` : '加载中…'}</span>
              <button className="btn-link ppt-nav" disabled={pptxCount <= 0 || pptxIndex >= pptxCount - 1} onClick={() => pptxRef.current?.next()} title="下一页">下一页 <Icon name="chevron-right" /></button>
            </div>
            <div className="ppt-stage">
              <PresentationViewer ref={pptxRef} src={pptxFile} wasm={pptxWasmUrl} width="100%" height="100%" onLoad={(info) => setPptxCount(info.slideCount)} onSlideChange={(i) => setPptxIndex(i)} />
            </div>
          </div>
        ) : officeSheets.length ? (
          <div className="file-preview-office">
            {officeSheets.map((sheet, i) => (
              <section key={i} className="office-sheet">
                {sheet.name ? <h4 className="office-sheet-title">{escapeHtml(sheet.name)}</h4> : null}
                <div className="office-sheet-body" dangerouslySetInnerHTML={{ __html: sheet.html }} />
              </section>
            ))}
          </div>
        ) : isText ? (
          <TextPreview content={content} line={line} />
        ) : (
          <div className="file-preview-content"><InlineLoading text="读取中…" /></div>
        )}
      </div>
    </div>
  )
}
