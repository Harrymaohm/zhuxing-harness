import { describe, expect, it } from 'vitest'
import { baseBundlePlugins } from '../src/index.js'

describe('基础 bundle', () => {
  it('以插件形态提供全部基础能力（无特权核心）', () => {
    const plugins = baseBundlePlugins({
      apiKey: 'k',
      model: 'm',
      workspace: process.cwd(),
      level: 'workspace-write',
    })
    expect(plugins.map((p) => p.name)).toEqual([
      'harness-sandbox',
      'harness-session',
      'harness-tools',
      'harness-llm',
      'harness-core-tools',
      'harness-image-tools',
      'harness-token-plan-media',
      'harness-memory',
      'harness-knowledge',
      'harness-skill-loader',
      'harness-model-router',
      'harness-agent',
    ])
    const agent = plugins.find((p) => p.name === 'harness-agent')!
    expect(agent.inject).toEqual(['llm', 'tools', 'sessionService'])
    const router = plugins.find((p) => p.name === 'harness-model-router')!
    expect(router.inject).toEqual(['llm', 'tools'])
    const memory = plugins.find((p) => p.name === 'harness-memory')!
    expect(memory.inject).toEqual(['tools'])
    const skillLoader = plugins.find((p) => p.name === 'harness-skill-loader')!
    expect(skillLoader.inject).toEqual(['tools'])
  })
})
