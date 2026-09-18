import { afterEach, describe, expect, it, vi } from 'vitest'
import { OpenAICompatibleProvider } from '../src/index.js'
import type { ChatResult } from '../src/index.js'

afterEach(() => vi.unstubAllGlobals())

/** 构造 SSE 响应的 mock Response。 */
function sseResponse(lines: string[]): Response {
  const encoder = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const line of lines) controller.enqueue(encoder.encode(`${line}\n\n`))
      controller.close()
    },
  })
  return { ok: true, status: 200, body, json: async () => ({}) } as unknown as Response
}

/** 将对象序列化为 SSE data 行（避免手写转义错误）。 */
function sse(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}`
}

describe('OpenAI 流式（SSE）', () => {
  it('逐 token 产出 + 工具调用增量累积 + done 完整结果', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        sseResponse([
          sse({ choices: [{ delta: { content: '你' } }] }),
          sse({ choices: [{ delta: { content: '好' } }] }),
          sse({
            choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 't', arguments: '{"a":' } }] } }],
          }),
          sse({
            choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '1}' } }] }, finish_reason: 'tool_calls' }],
          }),
          'data: [DONE]',
        ]),
      ),
    )
    const provider = new OpenAICompatibleProvider({ apiKey: 'k', model: 'm' })
    const tokens: string[] = []
    let done: ChatResult | undefined
    for await (const chunk of provider.stream!([{ role: 'user', content: 'x' }])) {
      if (chunk.token) tokens.push(chunk.token)
      if (chunk.done) done = chunk.done
    }
    expect(tokens).toEqual(['你', '好'])
    expect(done!.toolCalls).toEqual([{ id: 'c1', name: 't', arguments: '{"a":1}' }])
    expect(done!.content).toBe('你好')
    expect(done!.finishReason).toBe('tool_calls')

    // 请求体带 stream:true
    const [url, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(String(url)).toContain('/chat/completions')
    expect(JSON.parse(String(init.body)).stream).toBe(true)
  })

  it('流式错误（HTTP 非 2xx）抛出', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 429,
        statusText: 'Rate Limited',
        json: async () => ({ error: { message: 'too many requests' } }),
      })),
    )
    const provider = new OpenAICompatibleProvider({ apiKey: 'k', model: 'm' })
    const gen = provider.stream!([{ role: 'user', content: 'x' }])
    await expect(async () => {
      for await (const _chunk of gen) {
        // noop
      }
    }).rejects.toThrow(/429/)
  })
})
