import { afterEach, describe, expect, it, vi } from 'vitest'
import { OpenAICompatibleProvider } from '../src/index.js'

afterEach(() => vi.unstubAllGlobals())

describe('OpenAI 兼容适配器', () => {
  it('构造请求并解析响应（fetch mock）', async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => ({
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
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer k')
  })

  it('assistant 消息的 toolCalls 透传', async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => ({
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

  it('DeepSeek 端点下发 thinking/reasoning_effort/response_format 并解析缓存 usage', async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => ({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: '{"ok":true}' }, finish_reason: 'stop' }],
        usage: {
          prompt_tokens: 100,
          completion_tokens: 20,
          total_tokens: 120,
          prompt_cache_hit_tokens: 70,
          prompt_cache_miss_tokens: 30,
        },
      }),
    }))
    vi.stubGlobal('fetch', fetchMock)

    const provider = new OpenAICompatibleProvider({ apiKey: 'k', baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat' })
    const result = await provider.chat([{ role: 'user', content: 'x' }], {
      thinking: 'disabled',
      reasoningEffort: 'low',
      jsonMode: true,
      maxTokens: 4096,
    })

    const body = JSON.parse(String(fetchMock.mock.calls[0][1].body))
    expect(body.thinking).toEqual({ type: 'disabled' })
    expect(body.reasoning_effort).toBe('low')
    expect(body.response_format).toEqual({ type: 'json_object' })
    expect(body.max_tokens).toBe(4096)
    expect(result.usage?.cacheHitTokens).toBe(70)
    expect(result.usage?.cacheMissTokens).toBe(30)
  })

  it('非 DeepSeek 端点不下发专有参数（jsonMode 仍走标准字段）', async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => ({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: '{}' }, finish_reason: 'stop' }] }),
    }))
    vi.stubGlobal('fetch', fetchMock)

    const provider = new OpenAICompatibleProvider({ apiKey: 'k', model: 'gpt-4o' })
    await provider.chat([{ role: 'user', content: 'x' }], { thinking: 'disabled', reasoningEffort: 'low', jsonMode: true })

    const body = JSON.parse(String(fetchMock.mock.calls[0][1].body))
    expect(body.thinking).toBeUndefined()
    expect(body.reasoning_effort).toBeUndefined()
    expect(body.response_format).toEqual({ type: 'json_object' })
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
