import type { IncomingMessage, ServerResponse } from 'node:http'

// ============ SSE / JSON 工具 ============

export function sse(res: ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
}

export function sseEnd(res: ServerResponse): void {
  res.write('event: done\ndata: {}\n\n')
  res.end()
}

export function json(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(data))
}

export function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolveBody, rejectBody) => {
    let data = ''
    req.on('data', (chunk: Buffer) => {
      data += chunk.toString('utf-8')
      // 容纳 50MB 文件的 base64（约 66.7MB），预留 JSON 包裹与余量
      if (data.length > 80 * 1024 * 1024) rejectBody(new Error('请求体过大'))
    })
    req.on('end', () => {
      try {
        resolveBody(data ? JSON.parse(data) : {})
      } catch {
        rejectBody(new Error('JSON 解析失败'))
      }
    })
    req.on('error', rejectBody)
  })
}

/** 启动时读入内存的一份静态资源（带 MIME 与内容哈希 ETag）。 */
export interface StaticAsset {
  type: string
  data: Buffer
  etag: string
}

/** 静态资源表：相对路径 → 资源内容。 */
export type StaticAssets = Map<string, StaticAsset>
