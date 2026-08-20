import { afterEach, describe, expect, it, vi } from 'vitest'
import { OpenAICompatibleProvider } from '../src/index.js'

afterEach(() => vi.unstubAllGlobals())

describe('OpenAI 兼容适配器', () => {
  it('构造请求并解析响应（fetch mock）', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [
          {
            message: {
              content: 'hi',
              tool_calls: [{ id: 'c1', function: { name: 't', arguments: '{}' } }],
            },
            finish_reason: 'tool_calls',
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
      }),
    }))
    vi.stubGlobal('fetch', fetchMock)

    const provider = new OpenAICompatibleProvider({ apiKey: 'k', model: 'm' })
    const result = await provider.chat([{ role: 'user', content: 'x' }], {
      tools: [{ name: 't', description: 'd', schema: {} }],
    })

    expect(result.content).toBe('hi')
    expect(result.toolCalls).toHaveLength(1)
    expect(result.toolCalls[0].name).toBe('t')
    expect(result.usage?.totalTokens).toBe(3)

    // 校验请求体
    const [url, init] = fetchMock.mock.calls[0]
    expect(String(url)).toContain('/chat/completions')
    const body = JSON.parse(String(init.body))
    expect(body.model).toBe('m')
    expect(body.messages).toEqual([{ role: 'user', content: 'x' }])
    expect(body.tools[0].function.name).toBe('t')
    expect(init.headers.Authorization).toBe('Bearer k')
  })

  it('assistant 消息的 toolCalls 透传', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: 'done' }, finish_reason: 'stop' }] }),
    }))
    vi.stubGlobal('fetch', fetchMock)
    const provider = new OpenAICompatibleProvider({ apiKey: 'k', model: 'm' })
    await provider.chat([
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'c1', name: 't', arguments: '{}' }],
      },
      { role: 'tool', content: 'ok', toolCallId: 'c1' },
    ])
    const body = JSON.parse(String(fetchMock.mock.calls[0][1].body))
    expect(body.messages[0].tool_calls).toHaveLength(1)
    expect(body.messages[1].tool_call_id).toBe('c1')
  })

  it('HTTP 错误抛出并携带服务端信息', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
        json: async () => ({ error: { message: 'bad key' } }),
      })),
    )
    const provider = new OpenAICompatibleProvider({ apiKey: 'bad', model: 'm' })
    await expect(provider.chat([{ role: 'user', content: 'x' }])).rejects.toThrow(/bad key/)
  })

  it('超时中止请求', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
          }),
      ),
    )
    const provider = new OpenAICompatibleProvider({ apiKey: 'k', model: 'm', timeoutMs: 20 })
    await expect(provider.chat([{ role: 'user', content: 'x' }])).rejects.toThrow(/超时/)
  })
})
