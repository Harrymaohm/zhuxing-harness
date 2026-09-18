import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { json, readJsonBody } from '../http.js'
import type { RouteContext } from './context.js'

/** 弹出本地目录选择器（Windows PowerShell FolderBrowserDialog），返回选中路径；取消或失败返回空。 */
function pickFolderDialog(initialDir?: string): Promise<string> {
  return new Promise((resolvePromise) => {
    const psInit = initialDir ? `$d.SelectedPath = '${initialDir.replace(/'/g, "''")}';` : ''
    const script =
      `Add-Type -AssemblyName System.Windows.Forms;` +
      `$d = New-Object System.Windows.Forms.FolderBrowserDialog;` +
      `$d.Description = '选择工作区目录';` +
      `$d.ShowNewFolderButton = $true;` +
      psInit +
      `if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($d.SelectedPath) }`
    const child = spawn('powershell.exe', ['-NoProfile', '-Command', script], {
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    })
    let out = ''
    child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString('utf-8')))
    child.on('close', () => resolvePromise(out.trim()))
    child.on('error', () => resolvePromise(''))
  })
}

/** 工作区选择：一键临时目录 / 本地目录选择器。 */
export async function handleWorkspaceRoutes(req: IncomingMessage, res: ServerResponse, ctx: RouteContext): Promise<boolean> {
  const path = ctx.path
  // 一键生成临时工作区目录（无需真实项目目录）
  if (req.method === 'POST' && path === '/api/workspace/temp') {
    const base = join(homedir(), '.zhuxing-harness', 'workspaces')
    mkdirSync(base, { recursive: true })
    const name = `tmp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    const dir = join(base, name)
    mkdirSync(dir, { recursive: true })
    json(res, 200, { path: dir })
    return true
  }
  // 弹出本地目录选择器（Windows FolderBrowserDialog）
  if (req.method === 'POST' && path === '/api/workspace/pick') {
    const body = (await readJsonBody(req)) as { initial?: string }
    const picked = await pickFolderDialog(body.initial)
    if (!picked) {
      json(res, 200, { canceled: true })
      return true
    }
    json(res, 200, { path: picked })
    return true
  }
  return false
}
