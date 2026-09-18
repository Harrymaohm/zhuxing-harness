/**
 * 设置弹窗里的五块能力面板：专业化 / 记忆 / 技能 / 工具 / 更新。
 *
 * 从 App.tsx 原样搬出；面板专用的辅助声明（条目类型、上传编码、结果框）随之下移。
 * `fileToBase64` 被本文件与 App.tsx 的知识库上传共用，故落在 api.ts，两边各自 import——
 * 依赖方向单向，本文件绝不引 App。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { apiFetch, checkUpdate, fetchSpecs, fileToBase64, installSpec, installUpdateZip, removeSpec, setSpecEnabled, triggerUpdate } from '../api'
import type { SpecRecord, UpdateCheckResult } from '../api'
import type { MemoryEntry } from '../types'
import { Icon } from '../components/Icon'
import { InlineError, InlineLoading } from '../components/Inline'
import { useDebouncedValue } from '../hooks/useDebouncedValue'

/** 专业化能力包面板：安装 zip / 启停 / 移除。 */
export function SpecPanel({ onToast }: { onToast: (message: string) => void }) {
  const [specs, setSpecs] = useState<SpecRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [file, setFile] = useState<File | null>(null)
  const [installing, setInstalling] = useState(false)
  const [error, setError] = useState('')

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      setSpecs(await fetchSpecs())
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const doInstall = async () => {
    if (!file) {
      setError('请先选择 .zip 能力包文件')
      return
    }
    setInstalling(true)
    setError('')
    try {
      const data = await fileToBase64(file)
      const spec = await installSpec(data)
      setFile(null)
      onToast(`已安装专业化包「${spec.name}」`)
      void refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setInstalling(false)
    }
  }

  const doToggle = async (s: SpecRecord) => {
    const ok = await setSpecEnabled(s.id, !s.enabled)
    if (ok) {
      onToast(`已${!s.enabled ? '启用' : '禁用'}「${s.name}」`)
      void refresh()
    }
  }

  const doRemove = async (s: SpecRecord) => {
    if (!confirm(`确定移除「${s.name}」？其技能与知识将不再参与。`)) return
    const ok = await removeSpec(s.id)
    if (ok) {
      onToast(`已移除「${s.name}」`)
      void refresh()
    }
  }

  return (
    <>
      <div className="section-hint">
        专业化能力包是面向专业领域的增量包（如建筑、电网），打包为 zip（内含 manifest.json + skills/*.yaml + knowledge/*）。
        安装后按包启用：技能注册进技能系统、内置知识文档入库到知识库；禁用后自动隔离，不影响普通用户。
      </div>

      <div className="sub-model-card mb-3">
        <div className="sub-model-head">
          <span className="sub-idx">安装专业化包</span>
        </div>
        <div className="field-row">
          <label className="field grow">
            <span>选择 .zip 能力包</span>
            <input type="file" accept=".zip" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          </label>
          {file && <div className="meta self-end">{file.name}</div>}
        </div>
        <div className="row">
          <button className="btn primary" onClick={() => void doInstall()} disabled={installing || !file}>
            {installing ? '安装中…' : '安装并启用'}
          </button>
        </div>
        {error && <InlineError>{error}</InlineError>}
      </div>

      <div className="settings-section scroll-360">
        {loading ? (
          <div className="empty-hint"><InlineLoading /></div>
        ) : specs.length === 0 ? (
          <div className="empty-hint">未安装任何专业化包。选择一个 .zip 能力包安装以扩展专业能力。</div>
        ) : (
          specs.map((s) => (
            <div key={s.id} className="sub-model-card">
              <div className="sub-model-head">
                <span className="sub-idx">
                  {s.icon ?? <Icon name="package" />} {s.name} v{s.version} {s.category ? `[${s.category}]` : ''}
                  <span className={`meta spec-state${s.enabled ? ' on' : ''}`}>
                    {s.enabled ? '已启用' : '已禁用'}
                  </span>
                </span>
              </div>
              <div className="text-body">{s.description || '（无简介）'}</div>
              <div className="meta">技能 {s.skillCount} 个 · 知识文档 {s.knowledgeCount} 篇 · {new Date(s.installedAt).toLocaleString()}</div>
              <div className="row mt-2">
                <button className="btn" onClick={() => void doToggle(s)}>
                  {s.enabled ? '禁用' : '启用'}
                </button>
                <button className="btn-link danger" onClick={() => void doRemove(s)}>移除</button>
              </div>
            </div>
          ))
        )}
      </div>
    </>
  )
}

// 导出供行为测试（搜索防抖 / 序号丢弃的门禁用例）
export function MemoryPanel() {
  const [entries, setEntries] = useState<MemoryEntry[]>([])
  const [content, setContent] = useState('')
  const [scope, setScope] = useState<'user' | 'project' | 'auto'>('auto')
  const [tags, setTags] = useState('')
  const [q, setQ] = useState('')
  const [filterScope, setFilterScope] = useState<'all' | 'user' | 'project' | 'auto'>('all')
  const [loading, setLoading] = useState(false)

  // 搜索防抖 + 序号丢弃：与知识库面板同一套规则
  const dq = useDebouncedValue(q)
  const reqSeqRef = useRef(0)

  const refresh = useCallback(async () => {
    const seq = ++reqSeqRef.current
    setLoading(true)
    try {
      const params = new URLSearchParams()
      if (filterScope !== 'all') params.set('scope', filterScope)
      if (dq) params.set('q', dq)
      const res = await apiFetch(`/api/memory?${params}`)
      const data = res.ok ? ((await res.json()) as { entries: MemoryEntry[] }) : null
      if (seq !== reqSeqRef.current) return
      if (data) setEntries(data.entries)
    } catch {
      /* ignore */
    } finally {
      if (seq === reqSeqRef.current) setLoading(false)
    }
  }, [filterScope, dq])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const addMemory = async () => {
    const c = content.trim()
    if (!c) return
    try {
      const res = await apiFetch('/api/memory', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: c,
          scope,
          tags: tags ? tags.split(',').map((t) => t.trim()).filter(Boolean) : undefined,
        }),
      })
      if (res.ok) {
        setContent('')
        setTags('')
        void refresh()
      }
    } catch {
      /* ignore */
    }
  }

  const removeMemory = async (id: string) => {
    if (!confirm('确定删除该条记忆？此操作不可撤销。')) return
    try {
      const res = await apiFetch(`/api/memory/${encodeURIComponent(id)}`, { method: 'DELETE' })
      if (res.ok) void refresh()
    } catch {
      /* ignore */
    }
  }

  const clearAll = async () => {
    if (!confirm('确定清空全部记忆？此操作不可撤销。')) return
    try {
      await apiFetch('/api/memory/clear', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      void refresh()
    } catch {
      /* ignore */
    }
  }

  return (
    <>
      <div className="section-hint">
        AI 会自动将相关记忆注入到每次对话的 systemPrompt（user {'>'} project {'>'} auto 排序，4KB 截断）。
        AI 运行时也可调用 <code>remember</code> / <code>recall</code> 工具。
      </div>

      <div className="sub-model-card">
        <div className="sub-model-head">
          <span className="sub-idx">添加记忆</span>
        </div>
        <label className="field">
          <span>内容</span>
          <input value={content} placeholder="要记住的事实或偏好" onChange={(e) => setContent(e.target.value)} />
        </label>
        <div className="field-row">
          <label className="field">
            <span>作用域</span>
            <select value={scope} onChange={(e) => setScope(e.target.value as 'user' | 'project' | 'auto')}>
              <option value="user">user（跨项目偏好）</option>
              <option value="project">project（项目上下文）</option>
              <option value="auto">auto（自动学习）</option>
            </select>
          </label>
          <label className="field">
            <span>标签（逗号分隔）</span>
            <input value={tags} placeholder="code-style, tech-stack" onChange={(e) => setTags(e.target.value)} />
          </label>
        </div>
        <button className="btn primary" onClick={addMemory} disabled={!content.trim()}>
          添加
        </button>
      </div>

      <div className="field-row mb-3">
        <label className="field">
          <span>搜索</span>
          <input value={q} placeholder="关键词" onChange={(e) => setQ(e.target.value)} />
        </label>
        <label className="field">
          <span>作用域</span>
          <select value={filterScope} onChange={(e) => setFilterScope(e.target.value as 'all' | 'user' | 'project' | 'auto')}>
            <option value="all">全部</option>
            <option value="user">user</option>
            <option value="project">project</option>
            <option value="auto">auto</option>
          </select>
        </label>
      </div>

      <div className="settings-section scroll-280">
        {loading ? (
          <div className="empty-hint"><InlineLoading /></div>
        ) : entries.length === 0 ? (
          <div className="empty-hint">无记忆。AI 运行时调用 remember 工具或在此添加。</div>
        ) : (
          entries.map((e) => (
            <div key={e.id} className="sub-model-card">
              <div className="sub-model-head">
                <span className="sub-idx">
                  [{e.scope}] {e.tags?.length ? ` {${e.tags.join(',')}}` : ''}
                </span>
                <button className="btn-link danger" onClick={() => void removeMemory(e.id)}>
                  删除
                </button>
              </div>
              <div className="text-body">{e.content}</div>
              {e.workspace && <div className="meta">@{e.workspace}</div>}
            </div>
          ))
        )}
      </div>

      {entries.length > 0 && (
        <button className="btn-link danger mt-2" onClick={void clearAll}>
          清空全部
        </button>
      )}
    </>
  )
}

interface SkillEntry {
  name: string
  description: string
  icon?: string
  category?: string
  tags?: string[]
  template?: string
  inputs?: Record<string, unknown>
  tools?: string[]
  version?: string
  visibility?: string
  memory?: { scope: string; tags?: string[] }
}

interface SkillUploadCandidate {
  sourceFile: string
  skill: SkillEntry | null
  issues: string[]
  review: {
    status: 'approve' | 'reject' | 'needs_fix' | 'skipped'
    feedback: string
  }
}

const UPLOAD_ACCEPT = '.yaml,.yml,.md,.zip'

/**
 * 运行结果框：错误文本约定以 "!" 开头（状态里不写 emoji），渲染时换成警示图标 + 文本。
 */
function ResultBox({ text, tall }: { text: string; tall?: boolean }) {
  const isError = text.startsWith('!')
  return (
    <pre className={tall ? 'result-box tall' : 'result-box'}>
      {isError ? (<><Icon name="alert" /> {text.slice(1).trim()}</>) : text}
    </pre>
  )
}

// 导出供行为测试（与 MemoryPanel 同一理由）
export function SkillPanel() {
  const [skills, setSkills] = useState<SkillEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [q, setQ] = useState('')
  const [showAdd, setShowAdd] = useState(false)
  const [newName, setNewName] = useState('')
  const [newDesc, setNewDesc] = useState('')
  const [newTemplate, setNewTemplate] = useState('')
  const [newCategory, setNewCategory] = useState('')
  const [runSkill, setRunSkill] = useState<SkillEntry | null>(null)
  const [runArgs, setRunArgs] = useState('{}')
  const [runResult, setRunResult] = useState('')
  const [showUpload, setShowUpload] = useState(false)
  const [uploadFiles, setUploadFiles] = useState<File[]>([])
  const [uploadScope, setUploadScope] = useState<'global' | 'project'>('global')
  const [uploading, setUploading] = useState(false)
  // 上传/安装的结果提示：成功与失败分开存，避免靠「✓ / !」前缀在字符串里区分样式——
  // 那种写法一旦被后续消息覆盖，成功提示会变成红色错误框（反之亦然）。
  const [uploadNotice, setUploadNotice] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
  const [uploadCandidates, setUploadCandidates] = useState<SkillUploadCandidate[]>([])
  const [installing, setInstalling] = useState('')
  const uploadInputRef = useRef<HTMLInputElement>(null)

  // 搜索防抖 + 序号丢弃：与知识库面板同一套规则
  const dq = useDebouncedValue(q)
  const reqSeqRef = useRef(0)

  const refresh = useCallback(async () => {
    const seq = ++reqSeqRef.current
    setLoading(true)
    try {
      const res = await apiFetch(`/api/skills?q=${encodeURIComponent(dq)}`)
      const data = res.ok ? ((await res.json()) as { skills: SkillEntry[] }) : null
      if (seq !== reqSeqRef.current) return
      if (data) setSkills(data.skills)
    } catch {
      /* ignore */
    } finally {
      if (seq === reqSeqRef.current) setLoading(false)
    }
  }, [dq])

  useEffect(() => {
    void refresh()
  }, [refresh])

  async function addSkill() {
    const res = await apiFetch('/api/skills', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: newName,
        description: newDesc,
        template: newTemplate,
        category: newCategory || undefined,
        inputs: { type: 'object', properties: { input: { type: 'string' } }, required: ['input'] },
        tools: ['read_file', 'shell'],
      }),
    })
    if (res.ok) {
      setShowAdd(false)
      setNewName('')
      setNewDesc('')
      setNewTemplate('')
      setNewCategory('')
      void refresh()
    }
  }

  async function removeSkill(name: string) {
    if (!confirm(`确定删除技能「${name}」？此操作不可撤销。`)) return
    await apiFetch(`/api/skills/${encodeURIComponent(name)}`, { method: 'DELETE' })
    void refresh()
  }

  async function executeSkill() {
    if (!runSkill) return
    let args
    try {
      args = JSON.parse(runArgs)
    } catch {
      setRunResult('! 参数必须是合法 JSON')
      return
    }
    const res = await apiFetch(`/api/skills/${encodeURIComponent(runSkill.name)}/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ args }),
    })
    const data = (await res.json()) as { prompt?: string; error?: string }
    setRunResult(data.error ? `! ${data.error}` : data.prompt ?? '')
  }

  async function performUpload() {
    if (!uploadFiles.length) {
      setUploadNotice({ kind: 'err', text: '请先选择 .yaml/.yml、SKILL.md 或 .zip 文件' })
      return
    }
    setUploading(true)
    setUploadNotice(null)
    setUploadCandidates([])
    try {
      const files = await Promise.all(
        uploadFiles.map(async (f) => ({ name: f.name, dataBase64: await fileToBase64(f) })),
      )
      const res = await apiFetch('/api/skills/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ files, review: true }),
      })
      const data = (await res.json()) as { candidates?: SkillUploadCandidate[]; error?: string }
      if (!res.ok) {
        setUploadNotice({ kind: 'err', text: data.error ?? `上传失败（HTTP ${res.status}）` })
        return
      }
      setUploadCandidates(data.candidates ?? [])
    } catch (err) {
      setUploadNotice({ kind: 'err', text: err instanceof Error ? err.message : String(err) })
    } finally {
      setUploading(false)
    }
  }

  async function installCandidate(c: SkillUploadCandidate) {
    if (!c.skill) return
    setInstalling(c.sourceFile)
    setUploadNotice(null)
    try {
      const res = await apiFetch('/api/skills/install', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ skill: c.skill, scope: uploadScope }),
      })
      const data = (await res.json()) as { skill?: SkillEntry; dir?: string; error?: string }
      if (!res.ok) {
        setUploadNotice({ kind: 'err', text: data.error ?? `安装失败（HTTP ${res.status}）` })
        return
      }
      setUploadCandidates([])
      setUploadFiles([])
      setShowUpload(false)
      void refresh()
      setUploadNotice({ kind: 'ok', text: `已安装到 ${uploadScope === 'global' ? '全局' : '当前项目'}` })
    } catch (err) {
      setUploadNotice({ kind: 'err', text: err instanceof Error ? err.message : String(err) })
    } finally {
      setInstalling('')
    }
  }

  return (
    <>
      <div className="section-hint">
        技能是可复用的提示词模板 + 输入参数 + 工具子集。对话中输入 <code>/skill name args</code> 调用，
        或让 AI 自动调用 <code>use_skill</code> 工具。
      </div>

      <div className="field-row mb-3">
        <label className="field">
          <span>搜索</span>
          <input value={q} placeholder="名称/描述关键词" onChange={(e) => setQ(e.target.value)} />
        </label>
        <button className="btn primary" onClick={() => setShowAdd(true)}>
          + 新建
        </button>
        <button className="btn" onClick={() => { setShowUpload(true); setUploadNotice(null); setUploadCandidates([]) }}>
          <Icon name="upload" /> 上传
        </button>
      </div>

      {showUpload && (
        <div className="sub-model-card mb-3">
          <div className="sub-model-head">
            <span className="sub-idx">上传技能（.yaml / SKILL.md / .zip 批量）</span>
            <button className="btn-link" onClick={() => setShowUpload(false)}>
              关闭
            </button>
          </div>
          <div className="field-row mb-2">
            <label className="field grow">
              <span>选择文件</span>
              <input
                ref={uploadInputRef}
                type="file"
                multiple
                accept={UPLOAD_ACCEPT}
                onChange={(e) => setUploadFiles(Array.from(e.target.files ?? []))}
              />
            </label>
            <label className="field w-160">
              <span>安装位置</span>
              <select value={uploadScope} onChange={(e) => setUploadScope(e.target.value as 'global' | 'project')}>
                <option value="global">全局</option>
                <option value="project">当前项目</option>
              </select>
            </label>
          </div>
          <div className="meta mb-2">
            自有 YAML（.yaml/.yml）可直接上传；SKILL.md 须符合 Agent Skills 规范——YAML frontmatter 内含 name 与
            description，其后正文即提示词模板；zip 内按 &lt;技能名&gt;/SKILL.md 识别（可含多个技能）。
          </div>
          {uploadFiles.length > 0 && (
            <div className="file-list">
              已选：{uploadFiles.map((f) => f.name).join('、')}
            </div>
          )}
          <div className="row">
            <button className="btn primary" onClick={() => void performUpload()} disabled={uploading || !uploadFiles.length}>
              {uploading ? '解析中…' : '上传并审核'}
            </button>
            <button className="btn" onClick={() => { setUploadFiles([]); setUploadCandidates([]); setUploadNotice(null) }}>
              清空
            </button>
          </div>
          {uploadNotice && <div className={`meta ${uploadNotice.kind === 'ok' ? 'msg-ok' : 'msg-err'}`}>{uploadNotice.text}</div>}
          {uploadCandidates.length > 0 && (
            <div className="settings-section scroll-300 mt-2">
              {uploadCandidates.map((c, i) => {
                const ok = c.review.status !== 'reject' && c.issues.length === 0 && !!c.skill
                return (
                  <div key={`${c.sourceFile}-${i}`} className="sub-model-card">
                    <div className="sub-model-head">
                      <span className="sub-idx">
                        {c.skill?.icon ?? <Icon name="document" />} {c.sourceFile} · {c.skill?.name ?? '无效'}
                      </span>
                      <span
                        className={`meta review-state${c.review.status === 'approve' ? ' approve' : c.review.status === 'reject' ? ' reject' : c.review.status === 'needs_fix' ? ' needs-fix' : ''}`}
                      >
                        {c.review.status === 'approve' ? 'AI 通过'
                          : c.review.status === 'reject' ? 'AI 拒绝'
                            : c.review.status === 'needs_fix' ? '需修正'
                              : '未审核'}
                      </span>
                    </div>
                    {c.skill?.description && <div className="text-body">{c.skill.description}</div>}
                    {c.review.feedback && <div className="meta mt-1">意见：{c.review.feedback}</div>}
                    {c.issues.length > 0 && (
                      <div className="meta text-err mt-1">
                        问题：{c.issues.join('；')}
                      </div>
                    )}
                    <div className="row mt-2">
                      <button
                        className="btn primary"
                        disabled={!ok || installing === c.sourceFile}
                        onClick={() => void installCandidate(c)}
                      >
                        {installing === c.sourceFile ? '安装中…' : '安装'}
                      </button>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}

      {showAdd && (
        <div className="sub-model-card mb-3">
          <div className="sub-model-head">
            <span className="sub-idx">新建技能</span>
            <button className="btn-link" onClick={() => setShowAdd(false)}>
              取消
            </button>
          </div>
          <label className="field">
            <span>名称</span>
            <input value={newName} placeholder="如 code-review" onChange={(e) => setNewName(e.target.value)} />
          </label>
          <label className="field">
            <span>描述</span>
            <input value={newDesc} placeholder="技能用途" onChange={(e) => setNewDesc(e.target.value)} />
          </label>
          <label className="field">
            <span>分类</span>
            <input value={newCategory} placeholder="如 dev / writing" onChange={(e) => setNewCategory(e.target.value)} />
          </label>
          <label className="field">
            <span>提示词模板（含 {`{{input}}`} 占位符）</span>
            <textarea
              value={newTemplate}
              className="mono"
              placeholder="你是专家。处理：{{input}}"
              onChange={(e) => setNewTemplate(e.target.value)}
              rows={4}
            />
          </label>
          <button className="btn primary" onClick={addSkill} disabled={!newName.trim() || !newTemplate.trim()}>
            保存
          </button>
        </div>
      )}

      <div className="settings-section scroll-360">
        {loading ? (
          <div className="empty-hint"><InlineLoading /></div>
        ) : skills.length === 0 ? (
          <div className="empty-hint">无技能。点击「+ 新建」创建。</div>
        ) : (
          skills.map((s) => (
            <div key={s.name} className="sub-model-card">
              <div className="sub-model-head">
                <span className="sub-idx">
                  {s.icon ?? <Icon name="sparkle" />} {s.name} {s.category ? `[${s.category}]` : ''}
                </span>
                <div>
                  <button className="btn-link" onClick={() => { setRunSkill(s); setRunArgs('{}'); setRunResult('') }}>
                    运行
                  </button>
                  <button className="btn-link danger" onClick={() => void removeSkill(s.name)}>
                    删除
                  </button>
                </div>
              </div>
              <div className="text-body">{s.description}</div>
              {s.tools?.length ? <div className="meta">工具：{s.tools.join(', ')}</div> : null}
              {runSkill?.name === s.name && (
                <div className="run-box">
                  <label className="field">
                    <span>参数（JSON）</span>
                    <textarea
                      value={runArgs}
                      className="mono-sm"
                      onChange={(e) => setRunArgs(e.target.value)}
                      rows={2}
                    />
                  </label>
                  <button className="btn primary mt-1" onClick={() => void executeSkill()}>
                    执行
                  </button>
                  {runResult && <ResultBox text={runResult} />}
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </>
  )
}

interface ToolEntry {
  name: string
  description: string
  schema: Record<string, unknown>
}

export function ToolPanel() {
  const [tools, setTools] = useState<ToolEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState<ToolEntry | null>(null)
  const [args, setArgs] = useState('{}')
  const [result, setResult] = useState('')
  const [running, setRunning] = useState(false)

  useEffect(() => {
    void (async () => {
      setLoading(true)
      try {
        const res = await apiFetch('/api/tools')
        if (res.ok) {
          const data = (await res.json()) as { tools: ToolEntry[] }
          setTools(data.tools)
        }
      } catch {
        /* ignore */
      } finally {
        setLoading(false)
      }
    })()
  }, [])

  async function testTool() {
    if (!selected) return
    let parsed
    try {
      parsed = JSON.parse(args)
    } catch {
      setResult('! 参数必须是合法 JSON')
      return
    }
    setRunning(true)
    setResult('')
    try {
      const res = await apiFetch(`/api/tools/${encodeURIComponent(selected.name)}/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ args: parsed }),
      })
      const data = (await res.json()) as { result?: unknown; error?: string }
      setResult(data.error ? `! ${data.error}` : JSON.stringify(data.result, null, 2))
    } catch (err) {
      setResult(`! ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setRunning(false)
    }
  }

  const schemaProps = (selected?.schema as { properties?: Record<string, { type?: string; description?: string }> })?.properties ?? {}
  const required = (selected?.schema as { required?: string[] })?.required ?? []

  return (
    <>
      <div className="section-hint">
        选择一个已注册的工具，输入参数（JSON），点击执行查看结果。这是扣子式的「试运行」面板。
      </div>

      <div className="settings-section scroll-200 mb-3">
        {loading ? (
          <div className="empty-hint"><InlineLoading /></div>
        ) : tools.length === 0 ? (
          <div className="empty-hint">无工具</div>
        ) : (
          tools.map((t) => (
            <button
              key={t.name}
              className={`sub-model-card tool-item ${selected?.name === t.name ? 'active' : ''}`}
              onClick={() => { setSelected(t); setArgs('{}'); setResult('') }}
            >
              <div className="strong">{t.name}</div>
              <div className="text-sub">{t.description.slice(0, 100)}</div>
            </button>
          ))
        )}
      </div>

      {selected && (
        <div className="sub-model-card">
          <div className="sub-model-head">
            <span className="sub-idx">{selected.name}</span>
          </div>
          <div className="text-body mb-2">{selected.description}</div>
          {Object.keys(schemaProps).length > 0 && (
            <div className="text-sub mb-2">
              参数：{Object.entries(schemaProps).map(([k, v]) => `${k}(${v.type ?? 'any'})`).join(', ')}
              {required.length > 0 && ` · 必填：${required.join(', ')}`}
            </div>
          )}
          <label className="field">
            <span>参数（JSON）</span>
            <textarea
              value={args}
              className="mono-sm"
              onChange={(e) => setArgs(e.target.value)}
              rows={3}
            />
          </label>
          <button className="btn primary mt-2" onClick={() => void testTool()} disabled={running}>
            {running ? '执行中…' : '执行'}
          </button>
          {result && <ResultBox text={result} tall />}
        </div>
      )}
    </>
  )
}

export function UpdatePanel() {
  const [checking, setChecking] = useState(false)
  const [updating, setUpdating] = useState(false)
  const [checkResult, setCheckResult] = useState<UpdateCheckResult | null>(null)
  const [message, setMessage] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)

  async function doCheck() {
    setChecking(true)
    setMessage('')
    setCheckResult(null)
    try {
      setCheckResult(await checkUpdate())
    } catch (err) {
      setMessage(`检查失败：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setChecking(false)
    }
  }

  async function doUpdate() {
    setUpdating(true)
    setMessage('')
    try {
      const r = await triggerUpdate()
      setMessage(r.ok ? (r.message ?? '已提交更新，即将重启服务') : `更新失败：${r.error ?? '未知错误'}`)
    } catch (err) {
      setMessage(`更新失败：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setUpdating(false)
    }
  }

  async function onFile(input: HTMLInputElement) {
    const file = input.files?.[0]
    if (!file) return
    setMessage('')
    try {
      const data = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve((reader.result as string).split(',')[1] ?? '')
        reader.onerror = () => reject(reader.error ?? new Error('读取文件失败'))
        reader.readAsDataURL(file)
      })
      const r = await installUpdateZip(data, file.name)
      setMessage(r.ok ? (r.message ?? '已安装增量包，即将重启服务') : `安装失败：${r.error ?? '未知错误'}`)
    } catch (err) {
      setMessage(`安装失败：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      input.value = ''
    }
  }

  return (
    <>
      <div className="section-hint">
        应用内更新：在线检查新版本并全自动下载应用，或手动安装本地增量包（.zip）。
      </div>

      <div className="sub-model-card mb-3">
        <div className="strong mb-2">在线更新</div>
        {checkResult && (
          <div className="text-body mb-2">
            当前版本：{checkResult.currentVersion}
            {checkResult.hasUpdate ? (
              <> · 最新版本：{checkResult.latestVersion}（可更新）</>
            ) : (
              <> · 已是最新版本</>
            )}
            {checkResult.releaseNotes && (
              <div className="text-sub mt-1">{checkResult.releaseNotes}</div>
            )}
          </div>
        )}
        <div className="row">
          <button className="btn" onClick={() => void doCheck()} disabled={checking || updating}>
            {checking ? '检查中…' : '检查更新'}
          </button>
          <button
            className="btn primary"
            onClick={() => void doUpdate()}
            disabled={!checkResult?.hasUpdate || updating || checking}
          >
            {updating ? '更新中…' : '立即更新'}
          </button>
        </div>
      </div>

      <div className="sub-model-card">
        <div className="strong mb-2">手动安装增量包</div>
        <div className="text-sub mb-2">
          选择本地 .zip 增量包进行离线更新，安装后会自动重启服务。
        </div>
        <input ref={fileRef} type="file" accept=".zip" onChange={(e) => void onFile(e.target)} />
      </div>

      {message && <div className="section-hint mt-3">{message}</div>}
    </>
  )
}
