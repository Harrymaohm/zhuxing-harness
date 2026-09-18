// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'

import { extractLocalUrls, isSelfUrl } from '../src/components/PreviewPanel'

/**
 * jsdom 的默认地址是 http://localhost:3000/ —— 端口 3000 即「应用自身」，
 * 正好用来验证「同端口回环 = 自己」这条判据。
 */
describe('isSelfUrl', () => {
  it('同端口的回环地址视为应用自身', () => {
    expect(isSelfUrl('http://127.0.0.1:3000')).toBe(true)
    expect(isSelfUrl('http://localhost:3000/')).toBe(true)
    expect(isSelfUrl('http://0.0.0.0:3000')).toBe(true)
  })

  it('同源完整地址视为应用自身', () => {
    expect(isSelfUrl('http://localhost:3000/anything?a=1')).toBe(true)
  })

  it('其它端口不是自身', () => {
    expect(isSelfUrl('http://127.0.0.1:5173')).toBe(false)
    expect(isSelfUrl('http://localhost:8080')).toBe(false)
  })

  it('非法地址不抛错且判为不是自身', () => {
    expect(isSelfUrl('not-a-url')).toBe(false)
    expect(isSelfUrl('')).toBe(false)
  })
})

describe('extractLocalUrls', () => {
  it('识别本机地址', () => {
    expect(extractLocalUrls('服务已在 http://127.0.0.1:5173 启动')).toEqual(['http://127.0.0.1:5173'])
  })

  it('把 0.0.0.0 与 [::1] 归一化成 127.0.0.1', () => {
    expect(extractLocalUrls('listening on http://0.0.0.0:8080')).toEqual(['http://127.0.0.1:8080'])
    expect(extractLocalUrls('listening on http://[::1]:8080')).toEqual(['http://127.0.0.1:8080'])
  })

  it('剔除尾随标点', () => {
    expect(extractLocalUrls('打开 http://127.0.0.1:5173。')).toEqual(['http://127.0.0.1:5173'])
    expect(extractLocalUrls('见 http://127.0.0.1:5173,')).toEqual(['http://127.0.0.1:5173'])
    expect(extractLocalUrls('(http://127.0.0.1:5173)')).toEqual(['http://127.0.0.1:5173'])
  })

  it('排除应用自身的地址（否则预览面板会在 iframe 里套一个完整的自己）', () => {
    const text = '界面在 http://127.0.0.1:3000 ，dev server 在 http://127.0.0.1:5173'
    expect(extractLocalUrls(text)).toEqual(['http://127.0.0.1:5173'])
  })

  it('同一地址只出现一次', () => {
    expect(extractLocalUrls('http://127.0.0.1:5173 和 http://127.0.0.1:5173')).toEqual(['http://127.0.0.1:5173'])
  })

  it('不识别外站地址', () => {
    expect(extractLocalUrls('见 https://example.com/docs 与 http://192.168.1.5:8080')).toEqual([])
  })

  it('空输入返回空数组', () => {
    expect(extractLocalUrls('')).toEqual([])
    expect(extractLocalUrls(undefined as unknown as string)).toEqual([])
  })
})
