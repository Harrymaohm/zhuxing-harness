import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import AdmZip from 'adm-zip'
import type { ParsedSpec, SpecContents, SpecManifest, SpecManagerOptions, SpecRecord } from './types.js'

/** 默认基础目录：~/.zhuxing-harness/specs */
export function defaultSpecsDir(): string {
  return process.env.HARNESS_SPECS_DIR ?? join(homedir(), '.zhuxing-harness', 'specs')
}

/** 注册表文件路径。 */
export function specRegistryPath(dir: string = defaultSpecsDir()): string {
  return join(dir, 'index.json')
}

/** 严格 slug 校验（字母数字与 -_）。 */
const SPEC_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/

/** 生成短 id（用于默认回退）。 */
function genId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
}

export interface InstallResult {
  spec: SpecRecord
  contents: SpecContents
}

/**
 * 文件形式专业化包管理器：zip 安装 → 解包 → 写入 ~/.zhuxing-harness/specs/<id>/
 * 并持久化注册表。管理启用/禁用/移除；技能与知识文档由调用方桥接到对应服务。
 */
export class SpecManager {
  private dir: string
  private registryPath: string
  private cache?: Map<string, SpecRecord>

  constructor(opts: SpecManagerOptions = {}) {
    this.dir = opts.dir ?? defaultSpecsDir()
    this.registryPath = specRegistryPath(this.dir)
  }

  /** 包基础目录。 */
  get baseDir(): string {
    return this.dir
  }

  // ===== 注册表读写 =====

  private load(): Map<string, SpecRecord> {
    if (this.cache) return this.cache
    const map = new Map<string, SpecRecord>()
    try {
      if (existsSync(this.registryPath)) {
        const raw = readFileSync(this.registryPath, 'utf-8').trim()
        if (raw) {
          const arr = JSON.parse(raw) as SpecRecord[]
          for (const r of arr) if (r?.id) map.set(r.id, r)
        }
      }
    } catch {
      /* 损坏时从空开始 */
    }
    this.cache = map
    return map
  }

  private flush(): void {
    if (!this.cache) return
    mkdirSync(dirname(this.registryPath), { recursive: true })
    writeFileSync(this.registryPath, JSON.stringify([...this.cache.values()], null, 2), { encoding: 'utf-8', mode: 0o600 })
  }

  // ===== 查询 =====

  async list(): Promise<SpecRecord[]> {
    return [...this.load().values()].sort((a, b) => b.installedAt - a.installedAt)
  }

  async get(id: string): Promise<SpecRecord | undefined> {
    return this.load().get(id)
  }

  /** 已启用包的 id 列表。 */
  async enabledIds(): Promise<string[]> {
    return [...this.load().values()].filter((r) => r.enabled).map((r) => r.id)
  }

  /** 已禁用包的 id 列表（用于知识库检索隔离）。 */
  async disabledIds(): Promise<string[]> {
    return [...this.load().values()].filter((r) => !r.enabled).map((r) => r.id)
  }

  /** 已启用包的技能目录列表（供 skill store 扫描）。 */
  enabledSkillDirs(): string[] {
    const dirs: string[] = []
    for (const r of this.load().values()) {
      if (!r.enabled) continue
      const skillsDir = join(this.pkgDir(r.id), 'skills')
      if (existsSync(skillsDir)) dirs.push(skillsDir)
    }
    return dirs
  }

  /** 指定包的技能目录（存在才返回）。 */
  skillsDir(id: string): string {
    return join(this.pkgDir(id), 'skills')
  }

  /** 指定包的知识目录。 */
  knowledgeDir(id: string): string {
    return join(this.pkgDir(id), 'knowledge')
  }

  pkgDir(id: string): string {
    return join(this.dir, id)
  }

  // ===== 安装 =====

  /** 解析 zip 字节（不落盘），返回清单与文件清单。 */
  async parse(buffer: Buffer): Promise<ParsedSpec> {
    const zip = new AdmZip(buffer)
    const manifestEntry = zip.getEntry('manifest.json')
    if (!manifestEntry) throw new Error('缺少 manifest.json（专业化包必须包含清单）')
    let manifest: SpecManifest
    try {
      manifest = JSON.parse(manifestEntry.getData().toString('utf-8')) as SpecManifest
    } catch {
      throw new Error('manifest.json 不是合法的 JSON')
    }
    if (!manifest.id || !SPEC_ID_RE.test(manifest.id)) throw new Error('manifest.id 只能含字母数字与 -_，且以字母/数字开头')
    if (!manifest.name) manifest.name = manifest.id

    const wantedSkills = new Set(manifest.skills ?? [])
    const wantedKnowledge = new Set(manifest.knowledge ?? [])
    const skills: Array<{ name: string; content: Buffer }> = []
    const knowledge: Array<{ name: string; content: Buffer }> = []
    for (const entry of zip.getEntries()) {
      if (entry.isDirectory) continue
      const rel = entry.entryName.replace(/\\/g, '/')
      // skills/ 前缀：yaml/yml
      if (rel.startsWith('skills/')) {
        const name = rel.slice('skills/'.length)
        if (!name || !/\.(ya?ml)$/i.test(name)) continue
        if (wantedSkills.size && !wantedSkills.has(name)) continue
        skills.push({ name, content: entry.getData() })
      }
      // knowledge/ 前缀：文本类文档
      if (rel.startsWith('knowledge/')) {
        const name = rel.slice('knowledge/'.length)
        if (!name || !/\.(md|txt|csv|json|ya?ml|docx|pptx|xlsx|html?)$/i.test(name)) continue
        if (wantedKnowledge.size && !wantedKnowledge.has(name)) continue
        knowledge.push({ name, content: entry.getData() })
      }
    }
    return { manifest, skills, knowledge }
  }

  /** 安装 zip 并写入磁盘 + 注册表（默认启用）。返回落盘记录与文件清单。 */
  async install(buffer: Buffer): Promise<InstallResult> {
    const parsed = await this.parse(buffer)
    const { manifest, skills, knowledge } = parsed
    const id = manifest.id
    const now = Date.now()
    const existing = this.load().get(id)
    // 覆盖安装：先清空旧目录，避免残留文件
    const dir = this.pkgDir(id)
    rmSync(dir, { recursive: true, force: true })
    mkdirSync(join(dir, 'skills'), { recursive: true })
    mkdirSync(join(dir, 'knowledge'), { recursive: true })
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf-8')
    for (const s of skills) writeFileSync(join(dir, 'skills', s.name), s.content)
    for (const k of knowledge) writeFileSync(join(dir, 'knowledge', k.name), k.content)

    const record: SpecRecord = {
      id,
      name: manifest.name,
      version: manifest.version ?? '0.0.0',
      description: manifest.description,
      category: manifest.category,
      icon: manifest.icon,
      enabled: true,
      skillCount: skills.length,
      knowledgeCount: knowledge.length,
      installedAt: existing?.installedAt ?? now,
    }
    this.load().set(id, record)
    this.flush()
    return {
      spec: record,
      contents: {
        manifest,
        skills: skills.map((s) => ({ name: s.name, content: s.content.toString('utf-8') })),
        knowledge: knowledge.map((k) => ({ name: k.name, content: k.content.toString('utf-8') })),
      },
    }
  }

  // ===== 启用 / 禁用 / 移除 =====

  async enable(id: string): Promise<boolean> {
    const r = this.load().get(id)
    if (!r) return false
    r.enabled = true
    this.flush()
    return true
  }

  async disable(id: string): Promise<boolean> {
    const r = this.load().get(id)
    if (!r) return false
    r.enabled = false
    this.flush()
    return true
  }

  async remove(id: string): Promise<boolean> {
    const r = this.load().get(id)
    if (!r) return false
    rmSync(this.pkgDir(id), { recursive: true, force: true })
    this.load().delete(id)
    this.flush()
    return true
  }
}

/** 生成短 id（供调用方创建随机包 id）。 */
export { genId }
