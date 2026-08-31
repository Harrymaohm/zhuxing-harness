import type { EmbeddingConfig, EmbeddingProvider } from './types.js'

/**
 * 创建 OpenAI 兼容 /embeddings 的向量化提供方。
 * 要求配置 baseUrl + apiKey + model；任一缺失则 available=false（检索降级为关键词匹配）。
 */
export function createEmbeddingProvider(cfg: EmbeddingConfig): EmbeddingProvider {
  const baseUrl = (cfg.baseUrl ?? '').trim()
  const apiKey = (cfg.apiKey ?? '').trim()
  const model = (cfg.model ?? '').trim()
  const available = Boolean(baseUrl && apiKey && model)

  return {
    available,
    async embed(texts: string[]): Promise<number[][]> {
      if (!available) throw new Error('未配置 embedding 模型（缺 baseUrl/apiKey/model）')
      const base = safeBaseUrl(baseUrl)
      const url = `${base}/embeddings`
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model, input: texts }),
      })
      if (!res.ok) throw new Error(`embedding 调用失败（HTTP ${res.status}）`)
      const payload = (await res.json()) as { data?: Array<{ embedding?: number[] }> }
      const data = payload.data ?? []
      if (data.length === 0) throw new Error('embedding 返回为空')
      return texts.map((_, i) => data[i]?.embedding ?? [])
    },
  }
}

/** 归一化 baseUrl：保留路径部分（如 /v1），仅去除末尾斜杠。不能用 .origin，否则会丢弃 /v1 导致 /embeddings 拼错。 */
function safeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '')
}
