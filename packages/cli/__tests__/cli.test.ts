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
    // agent 循环依赖声明
    const agent = plugins.find((p) => p.name === 'harness-agent')!
    expect(agent.inject).toEqual(['llm', 'tools', 'sessionService'])
    // 工具插件依赖注册表
    const coreTools = plugins.find((p) => p.name === 'harness-core-tools')!
    expect(coreTools.inject).toEqual(['tools'])
    // 模型路由插件依赖 llm + tools
    const router = plugins.find((p) => p.name === 'harness-model-router')!
    expect(router.inject).toEqual(['llm', 'tools'])
    // 记忆插件依赖 tools
    const memory = plugins.find((p) => p.name === 'harness-memory')!
    expect(memory.inject).toEqual(['tools'])
    // 技能加载器依赖 tools
    const skillLoader = plugins.find((p) => p.name === 'harness-skill-loader')!
    expect(skillLoader.inject).toEqual(['tools'])
  })
})
