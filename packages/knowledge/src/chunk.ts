/** 知识分块选项。 */
export interface ChunkOptions {
  /** 目标块长度（字符）。默认 800。 */
  size?: number
  /** 相邻块重叠（字符），保留上下文。默认 120。 */
  overlap?: number
}

/** 把长文本切断为段落感知、大小受限的块集合。 */
export function chunkText(text: string, opts: ChunkOptions = {}): string[] {
  const size = Math.max(80, opts.size ?? 800)
  const overlap = Math.max(0, opts.overlap ?? 120)
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim()
  if (!normalized) return []

  // 先按空行切段，再按目标长度聚合成块（保留段落边界，避免把句子拦腰截断）
  const paragraphs = normalized.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean)
  const chunks: string[] = []
  let buffer = ''
  for (const para of paragraphs) {
    // 单段超长时按窗口拆分
    if (para.length > size) {
      if (buffer) {
        chunks.push(buffer)
        buffer = ''
      }
      for (const piece of sliceWindow(para, size, overlap)) chunks.push(piece)
      continue
    }
    if (buffer && buffer.length + para.length + 1 > size) {
      chunks.push(buffer)
      buffer = buffer.slice(-overlap)
    }
    buffer = buffer ? `${buffer}\n\n${para}` : para
  }
  if (buffer) chunks.push(buffer)
  return chunks.filter((c) => c.trim().length > 0)
}

/** 对超长单段按滑动窗口切片。 */
function sliceWindow(text: string, size: number, overlap: number): string[] {
  const out: string[] = []
  let start = 0
  while (start < text.length) {
    const end = Math.min(text.length, start + size)
    out.push(text.slice(start, end))
    if (end >= text.length) break
    start = Math.max(0, end - overlap)
  }
  return out
}
