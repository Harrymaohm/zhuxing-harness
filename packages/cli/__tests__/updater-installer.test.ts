import { describe, expect, it } from 'vitest'
import { installerUpdateAvailable } from '../src/updater.js'

describe('安装包轨判定（installerUpdateAvailable）', () => {
  it('manifest 未声明 installer 时不提示重装', () => {
    expect(installerUpdateAvailable({}, '0.3.21')).toBeUndefined()
    expect(installerUpdateAvailable({ installer: undefined }, '0.3.21')).toBeUndefined()
  })

  it('installer.version 高于当前版本时返回重装指引（含 url / notes 透传）', () => {
    const manifest = { installer: { version: '0.4.0', url: 'https://example.com/setup.exe', notes: '新运行时' } }
    expect(installerUpdateAvailable(manifest, '0.3.21')).toEqual({ version: '0.4.0', url: 'https://example.com/setup.exe', notes: '新运行时' })
  })

  it('installer.version 等于或低于当前版本时不提示', () => {
    expect(installerUpdateAvailable({ installer: { version: '0.3.21' } }, '0.3.21')).toBeUndefined()
    expect(installerUpdateAvailable({ installer: { version: '0.3.20' } }, '0.3.21')).toBeUndefined()
  })

  it('installer 声明缺 version 字段时视为无效，不提示', () => {
    expect(installerUpdateAvailable({ installer: {} as { version: string } }, '0.3.21')).toBeUndefined()
  })
})
