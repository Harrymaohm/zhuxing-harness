import { describe, expect, it } from 'vitest'
import { parseModelsConfig } from '../src/index.js'

/**
 * 这份测试保护的是 CLI / Web / runtime 三方共用的模型配置解析（见 model-router 的 config.ts）。
 * 因为它成了唯一实现，任何一处行为变化都会同时影响三个入口，所以容错边界要逐个钉住。
 */
describe('模型配置解析（全仓唯一实现）', () => {
  it('已解析的数组原样返回', () => {
    const models = [{ model: 'deepseek-chat' }, { model: 'deepseek-coder' }]
    expect(parseModelsConfig({ models })).toEqual(models)
  })

  it('JSON 字符串解析为数组（环境变量 / 表单输入的形态）', () => {
    expect(parseModelsConfig({ models: '[{"model":"a"},{"model":"b"}]' })).toEqual([{ model: 'a' }, { model: 'b' }])
  })

  it('没配 / 空值一律按「未配置」返回 undefined', () => {
    expect(parseModelsConfig(undefined)).toBeUndefined()
    expect(parseModelsConfig(null)).toBeUndefined()
    expect(parseModelsConfig({})).toBeUndefined()
    expect(parseModelsConfig({ models: undefined })).toBeUndefined()
    expect(parseModelsConfig({ models: '' })).toBeUndefined()
    expect(parseModelsConfig({ models: 0 })).toBeUndefined()
  })

  it('显式空数组是「配了但为空」，不等于未配置', () => {
    expect(parseModelsConfig({ models: [] })).toEqual([])
    expect(parseModelsConfig({ models: '[]' })).toEqual([])
  })

  it('坏 JSON 或非数组内容 → undefined（不抛错，调用方回退默认模型）', () => {
    expect(parseModelsConfig({ models: '{ 坏掉的 json' })).toBeUndefined()
    expect(parseModelsConfig({ models: '{"model":"a"}' })).toBeUndefined()
    expect(parseModelsConfig({ models: { model: 'a' } })).toBeUndefined()
    expect(parseModelsConfig({ models: 'null' })).toBeUndefined()
  })

  it('兼容带索引签名的弱类型配置（CLI 的 HarnessConfig 就是这种形态）', () => {
    const weak: { [key: string]: unknown } = { models: '[{"model":"x"}]', apiKey: 'sk-***' }
    expect(parseModelsConfig(weak)).toEqual([{ model: 'x' }])
  })

  it('非对象入参不炸', () => {
    expect(parseModelsConfig('字符串')).toBeUndefined()
    expect(parseModelsConfig(42)).toBeUndefined()
  })
})
