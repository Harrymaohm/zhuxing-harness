/**
 * 设置弹窗：模型 / 能力 / 系统三组二级标签页。
 *
 * 单独成文件并按需加载的原因：弹窗内挂着专业化、记忆、技能、工具、更新五块面板，
 * 这些界面首屏完全用不到，钉在首屏 chunk 里等于让所有人先下载一遍。导出为命名导出，
 * 由 App 侧 `lazy()` 包装。
 */
import { useCallback, useRef, useState } from 'react'
import { createTempWorkspace, fetchTokenPlanModels, pickWorkspaceDir } from '../api'
import { CAPABILITY_LABELS, CAPABILITY_OPTIONS } from '../types'
import type { ImageModelEntry, SubModelEntry, TokenPlanEntry, TokenPlanImageEntry, TokenPlanSimpleEntry, TokenPlanTextEntry, WebConfig } from '../types'
import { useModalA11y } from '../hooks/useModalA11y'
import { MemoryPanel, SkillPanel, SpecPanel, ToolPanel, UpdatePanel } from './Panels'
import { Icon } from '../components/Icon'

/** token-plan 专用域名（阿里云百炼聚合 API）。 */
const TOKEN_PLAN_ORIGIN = 'https://token-plan.cn-beijing.maas.aliyuncs.com'

/** 生图模型建议项（下拉提示，仍可自由输入）。 */
const IMAGE_MODEL_PRESETS = [
  'qwen-image',
  'qwen-image-plus',
  'qwen-image-max',
  'qwen-image-2.0',
  'qwen-image-2.0-pro',
  'qwen-image-3.0',
  'qwen-image-3.0-pro',
  'wanx-v1',
  'dall-e-3',
  'gpt-image-1',
]

/** 设置分组：一级三组，组内二级；标签沿用既有叫法。 */
const SETTINGS_GROUPS = [
  {
    key: 'model',
    label: '模型',
    tabs: [
      { key: 'main', label: '主模型' },
      { key: 'sub', label: '子模型' },
      { key: 'image', label: '生图模型' },
      { key: 'token-plan', label: 'token-plan' },
    ],
  },
  {
    key: 'ability',
    label: '能力',
    tabs: [
      { key: 'specs', label: '专业化' },
      { key: 'skills', label: '技能' },
      { key: 'tools', label: '工具' },
      { key: 'memory', label: '记忆' },
    ],
  },
  {
    key: 'system',
    label: '系统',
    tabs: [
      { key: 'env', label: '运行环境' },
      { key: 'update', label: '更新' },
    ],
  },
] as const

type SettingsTab = (typeof SETTINGS_GROUPS)[number]['tabs'][number]['key']
type SettingsGroupKey = (typeof SETTINGS_GROUPS)[number]['key']

/**
 * token-plan 的模型分组折叠块。
 *
 * 5 组可增删的模型卡片一次性铺开时，只想填一个 Key 的用户要先翻过四屏无关表单；
 * 折叠交互与消息区一致（trae-section-toggle + aria-expanded），折叠标题上带条目数。
 */
function TpGroup({
  title,
  count,
  open,
  onToggle,
  children,
}: {
  title: string
  count: number
  open: boolean
  onToggle: () => void
  children: React.ReactNode
}) {
  return (
    // 组间距与原来的 sub-heading 保持一致
    <div className="trae-section mt-3 mb-3">
      <button className="trae-section-toggle" onClick={onToggle} aria-expanded={open}>
        <span className="trae-section-name">{count > 0 ? `${title}（${count}）` : title}</span>
        <span className="trae-caret">{open ? '▾' : '▸'}</span>
      </button>
      {open && children}
    </div>
  )
}

export function SettingsModal({
  config,
  onSave,
  onToast,
  onClose,
}: {
  config: WebConfig
  onSave: (patch: Partial<WebConfig>) => void
  onToast: (message: string) => void
  onClose: () => void
}) {
  const [form, setForm] = useState<WebConfig>({
    ...config,
    models: (config.models ?? []).map((m) => ({ ...m })),
    imageModel: config.imageModel ? { ...config.imageModel } : undefined,
    tokenPlan: config.tokenPlan
      ? {
          ...config.tokenPlan,
          textModels: (config.tokenPlan.textModels ?? []).map((m) => ({ ...m })),
          imageModels: (config.tokenPlan.imageModels ?? []).map((m) => ({ ...m })),
          videoModels: (config.tokenPlan.videoModels ?? []).map((m) => ({ ...m })),
          voiceModels: (config.tokenPlan.voiceModels ?? []).map((m) => ({ ...m })),
          realtimeModels: (config.tokenPlan.realtimeModels ?? []).map((m) => ({ ...m })),
        }
      : undefined,
  })
  const [group, setGroup] = useState<SettingsGroupKey>('model')
  const [tab, setTab] = useState<SettingsTab>('main')

  /** 切换一级组时自动落到该组第一个 tab。 */
  const switchGroup = (key: SettingsGroupKey) => {
    setGroup(key)
    const first = SETTINGS_GROUPS.find((g) => g.key === key)?.tabs[0].key
    if (first) setTab(first)
  }

  // 本弹窗「挂载即打开」；onClose 每次父渲染都会重建，包一层稳定引用，避免 Esc 监听与焦点还原被反复重绑。
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  const closeModal = useCallback(() => onCloseRef.current(), [])
  const modalRef = useModalA11y(true, closeModal)

  const setField = (key: keyof WebConfig, value: string) => setForm({ ...form, [key]: value })

  const applyTempWorkspace = async () => {
    const dir = await createTempWorkspace()
    if (!dir) {
      onToast('创建临时工作区失败')
      return
    }
    setField('workspace', dir)
    onToast('已生成临时工作区')
  }

  const pickWorkspace = async () => {
    const dir = await pickWorkspaceDir()
    if (dir === null) return // 用户取消或失败
    setField('workspace', dir)
    onToast('已选择工作区')
  }

  const subModels = form.models ?? []
  const patchSub = (idx: number, patch: Partial<SubModelEntry>) => {
    const copy = [...subModels]
    copy[idx] = { ...copy[idx], ...patch }
    setForm({ ...form, models: copy })
  }
  const addSub = () => setForm({ ...form, models: [...subModels, { id: '', model: '', capabilities: ['general'] }] })
  const removeSub = (idx: number) => setForm({ ...form, models: subModels.filter((_, i) => i !== idx) })

  const img = form.imageModel
  const patchImg = (patch: Partial<ImageModelEntry>) => setForm({ ...form, imageModel: { model: '', ...(img ?? {}), ...patch } })

  // ===== token-plan 表单辅助 =====
  const tokenPlan = form.tokenPlan
  const patchTokenPlan = (patch: Partial<TokenPlanEntry>) => setForm({ ...form, tokenPlan: { ...(tokenPlan ?? {}), ...patch } })
  const tpText = tokenPlan?.textModels ?? []
  const tpImage = tokenPlan?.imageModels ?? []
  const tpVideo = tokenPlan?.videoModels ?? []
  const tpVoice = tokenPlan?.voiceModels ?? []
  const tpRealtime = tokenPlan?.realtimeModels ?? []
  const patchTpText = (idx: number, patch: Partial<TokenPlanTextEntry>) => {
    const copy = [...tpText]
    copy[idx] = { ...copy[idx], ...patch }
    patchTokenPlan({ textModels: copy })
  }
  const addTpText = () => patchTokenPlan({ textModels: [...tpText, { id: '', model: '', capabilities: ['general'] }] })
  const removeTpText = (idx: number) => patchTokenPlan({ textModels: tpText.filter((_, i) => i !== idx) })
  const patchTpImage = (idx: number, patch: Partial<TokenPlanImageEntry>) => {
    const copy = [...tpImage]
    copy[idx] = { ...copy[idx], ...patch }
    patchTokenPlan({ imageModels: copy })
  }
  const addTpImage = () => patchTokenPlan({ imageModels: [...tpImage, { model: '' }] })
  const removeTpImage = (idx: number) => patchTokenPlan({ imageModels: tpImage.filter((_, i) => i !== idx) })
  // 视频 / 语音 / Realtime 均为简单的 model+label 条目，复用同一套增删改逻辑
  type TpSimpleKind = 'videoModels' | 'voiceModels' | 'realtimeModels'
  const tpSimpleList = (kind: TpSimpleKind) =>
    kind === 'videoModels' ? tpVideo : kind === 'voiceModels' ? tpVoice : tpRealtime
  const patchTpSimple = (kind: TpSimpleKind, idx: number, patch: Partial<TokenPlanSimpleEntry>) => {
    const list = [...tpSimpleList(kind)]
    list[idx] = { ...list[idx], ...patch }
    patchTokenPlan({ [kind]: list } as Partial<TokenPlanEntry>)
  }
  const addTpSimple = (kind: TpSimpleKind) => {
    patchTokenPlan({ [kind]: [...tpSimpleList(kind), { model: '' }] } as Partial<TokenPlanEntry>)
  }
  const removeTpSimple = (kind: TpSimpleKind, idx: number) => {
    patchTokenPlan({ [kind]: tpSimpleList(kind).filter((_, i) => i !== idx) } as Partial<TokenPlanEntry>)
  }

  // 折叠状态只对文本组以外生效：多数人只需填一个 Key + 一个文本模型，其余四组按需展开
  type TpGroupKey = 'image' | 'video' | 'voice' | 'realtime'
  const [tpOpenGroups, setTpOpenGroups] = useState<TpGroupKey[]>([])
  const toggleTpGroup = (key: TpGroupKey) =>
    setTpOpenGroups((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]))

  // ===== 从上游读取 token-plan 模型并自动填入 =====
  const [tpLoading, setTpLoading] = useState(false)
  const [tpError, setTpError] = useState('')
  async function loadTokenPlanModels() {
    if (!tokenPlan?.apiKey) {
      setTpError('请先填写 token-plan API Key')
      return
    }
    setTpLoading(true)
    setTpError('')
    try {
      const res = await fetchTokenPlanModels()
      const patch: Partial<TokenPlanEntry> = {}
      // 文本子模型：以 model 同时作为 id 唯一标识，能力标签按上游/推断补齐
      if (res.textModels.length) {
        patch.textModels = res.textModels.map((m) => ({
          id: m.model,
          model: m.model,
          label: m.label ?? m.model,
          capabilities: m.capabilities?.length ? m.capabilities : ['general'],
        }))
      }
      // 多模态清单：直接回填对应分类
      const img = res.builtin
      patch.imageModels = img.imageModels.map((m) => ({ model: m.model }))
      patch.videoModels = img.videoModels.slice()
      patch.voiceModels = img.voiceModels.slice()
      patch.realtimeModels = img.realtimeModels.slice()
      patchTokenPlan(patch)
      setTpError(res.error ? `上游读取失败，已回退内置清单：${res.error}` : '')
    } catch (e) {
      setTpError(e instanceof Error ? e.message : String(e))
    } finally {
      setTpLoading(false)
    }
  }

  function save() {
    // 过滤无效子模型条目（id 或 model 为空）
    const models = subModels.filter((m) => m.id.trim() && m.model.trim())
    const imageModel = img && img.model.trim() ? img : undefined
    const patch: Partial<WebConfig> = { ...form, models, imageModel }
    // 服务端返回的是脱敏值（含 ***）：未修改的密钥字段不提交，避免掩码覆盖真实 Key
    const isMasked = (v?: string) => !!v && v.includes('***')
    if (isMasked(patch.apiKey)) delete patch.apiKey
    patch.models = models.map((m) => (isMasked(m.apiKey) ? { ...m, apiKey: undefined } : m))
    if (patch.imageModel && isMasked(patch.imageModel.apiKey)) {
      patch.imageModel = { ...patch.imageModel, apiKey: undefined }
    }
    // token-plan：过滤空条目、脱敏 apiKey
    if (patch.tokenPlan) {
      const tp = patch.tokenPlan
      const textModels = (tp.textModels ?? []).filter((m) => m.id.trim() && m.model.trim())
      const imageModels = (tp.imageModels ?? []).filter((m) => m.model.trim())
      const videoModels = (tp.videoModels ?? []).filter((m) => m.model.trim())
      const voiceModels = (tp.voiceModels ?? []).filter((m) => m.model.trim())
      const realtimeModels = (tp.realtimeModels ?? []).filter((m) => m.model.trim())
      const clean: Partial<TokenPlanEntry> = { ...tp, textModels, imageModels, videoModels, voiceModels, realtimeModels }
      if (isMasked(clean.apiKey)) clean.apiKey = undefined
      patch.tokenPlan = clean
    }
    onSave(patch)
  }

  return (
    <div className="modal-mask" onClick={onClose}>
      <div
        className="modal settings-modal"
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-label="设置"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation()
            closeModal()
          }
        }}
      >
        <h3>设置</h3>
        <div className="settings-groups" role="tablist" aria-label="设置分组">
          {SETTINGS_GROUPS.map((g) => (
            <button
              key={g.key}
              role="tab"
              aria-selected={group === g.key}
              className={`settings-group${group === g.key ? ' active' : ''}`}
              onClick={() => switchGroup(g.key)}
            >
              {g.label}
            </button>
          ))}
        </div>
        <div className="settings-subtabs" role="tablist" aria-label="设置项">
          {SETTINGS_GROUPS.find((g) => g.key === group)?.tabs.map((t) => (
            <button
              key={t.key}
              role="tab"
              aria-selected={tab === t.key}
              className={`settings-subtab${tab === t.key ? ' active' : ''}`}
              onClick={() => setTab(t.key)}
            >
              {t.key === 'sub' ? `子模型（${subModels.length}）` : t.label}
            </button>
          ))}
        </div>

        {tab === 'main' && (
          <div className="settings-section">
            <p className="section-hint">主编排模型：负责理解任务、调用工具，并可动态委派子模型。</p>
            <label className="field">
              <span>API Key</span>
              <input
                type="password"
                value={form.apiKey ?? ''}
                placeholder="sk-…"
                onChange={(e) => setField('apiKey', e.target.value)}
              />
            </label>
            <label className="field">
              <span>Base URL（OpenAI 兼容端点）</span>
              <input
                value={form.baseUrl ?? ''}
                placeholder="https://api.deepseek.com/v1"
                onChange={(e) => setField('baseUrl', e.target.value)}
              />
            </label>
            <label className="field">
              <span>模型名</span>
              <input
                value={form.model ?? ''}
                placeholder="deepseek-v4-flash"
                onChange={(e) => setField('model', e.target.value)}
              />
            </label>
            <label className="field checkbox-field">
              <span>多模态（支持图片输入）</span>
              <input
                type="checkbox"
                checked={!!form.multimodal}
                onChange={(e) => setForm({ ...form, multimodal: e.target.checked })}
              />
            </label>
            <label className="field checkbox-field">
              <span>指令精炼（先拆解成任务书再执行）</span>
              <input
                type="checkbox"
                // 默认开启：配置里没有该字段时后端按开启处理，所以判断用 !== false
                checked={form.refineInstruction !== false}
                onChange={(e) => setForm({ ...form, refineInstruction: e.target.checked })}
              />
            </label>
          </div>
        )}

        {tab === 'sub' && (
          <div className="settings-section">
            <p className="section-hint">
              子模型由主编排模型按任务需求自动选择（能力匹配 + 上下文 + 实时性能），也可在对话中指定。
            </p>
            {subModels.map((m, idx) => (
              <div key={idx} className="sub-model-card">
                <div className="sub-model-head">
                  <span className="sub-idx">#{idx + 1}</span>
                  <button className="btn-link danger" onClick={() => removeSub(idx)}>
                    删除
                  </button>
                </div>
                <div className="field-row">
                  <label className="field">
                    <span>模型 ID（唯一标识）</span>
                    <input value={m.id} placeholder="coder" onChange={(e) => patchSub(idx, { id: e.target.value })} />
                  </label>
                  <label className="field">
                    <span>模型名</span>
                    <input
                      value={m.model}
                      placeholder="deepseek-coder"
                      onChange={(e) => patchSub(idx, { model: e.target.value })}
                    />
                  </label>
                </div>
                <div className="field-row">
                  <label className="field">
                    <span>显示名称（可选）</span>
                    <input value={m.label ?? ''} placeholder="代码专家" onChange={(e) => patchSub(idx, { label: e.target.value })} />
                  </label>
                  <label className="field">
                    <span>上下文窗口（token，可选）</span>
                    <input
                      type="number"
                      value={m.contextWindow ?? ''}
                      placeholder="64000"
                      onChange={(e) => patchSub(idx, { contextWindow: e.target.value ? Number(e.target.value) : undefined })}
                    />
                  </label>
                </div>
                <label className="field">
                  <span>能力标签（影响自动选择）</span>
                  <div className="cap-tags">
                    {CAPABILITY_OPTIONS.map((cap) => {
                      const active = (m.capabilities ?? []).includes(cap)
                      return (
                        <button
                          key={cap}
                          className={`cap-tag ${active ? 'active' : ''}`}
                          onClick={() => {
                            const caps = m.capabilities ?? []
                            patchSub(idx, { capabilities: active ? caps.filter((c) => c !== cap) : [...caps, cap] })
                          }}
                        >
                          {CAPABILITY_LABELS[cap] ?? cap}
                        </button>
                      )
                    })}
                  </div>
                </label>
                <div className="field-row">
                  <label className="field">
                    <span>Base URL（可选，缺省用主端点）</span>
                    <input value={m.baseUrl ?? ''} placeholder="留空 = 主端点" onChange={(e) => patchSub(idx, { baseUrl: e.target.value })} />
                  </label>
                  <label className="field">
                    <span>API Key（可选，缺省用主 Key）</span>
                    <input
                      type="password"
                      value={m.apiKey ?? ''}
                      placeholder="留空 = 主 Key"
                      onChange={(e) => patchSub(idx, { apiKey: e.target.value })}
                    />
                  </label>
                </div>
              </div>
            ))}
            <button className="btn add-sub" onClick={addSub}>
              + 添加子模型
            </button>
          </div>
        )}

        {tab === 'image' && (
          <div className="settings-section">
            <p className="section-hint">配置后 Agent 获得 generate_image 工具，可按描述生成图片。阿里云百炼 qwen-image 系列请选择 DashScope 原生模式。</p>
            <label className="field">
              <span>协议模式</span>
              <select value={img?.mode ?? 'openai'} onChange={(e) => patchImg({ mode: (e.target.value as 'openai' | 'dashscope') })}>
                <option value="openai">OpenAI 兼容（images 端点，dall-e-3 / wanx 等）</option>
                <option value="dashscope">DashScope 原生（阿里云百炼 qwen-image 系列）</option>
              </select>
            </label>
            <label className="field">
              <span>生图模型名</span>
              <input
                list="image-model-presets"
                value={img?.model ?? ''}
                placeholder="wanx-v1 / dall-e-3（留空 = 未启用）"
                onChange={(e) => patchImg({ model: e.target.value })}
              />
              <datalist id="image-model-presets">
                {IMAGE_MODEL_PRESETS.map((m) => (
                  <option key={m} value={m} />
                ))}
              </datalist>
            </label>
            <label className="field">
              <span>Base URL（可选，缺省用主端点）</span>
              <input value={img?.baseUrl ?? ''} placeholder={img?.mode === 'dashscope' ? 'https://dashscope.aliyuncs.com' : 'https://api.deepseek.com/v1'} onChange={(e) => patchImg({ baseUrl: e.target.value })} />
            </label>
            <label className="field">
              <span>API Key（可选，缺省用主 Key）</span>
              <input type="password" value={img?.apiKey ?? ''} placeholder="留空 = 主 Key" onChange={(e) => patchImg({ apiKey: e.target.value })} />
            </label>
            <label className="field">
              <span>默认尺寸</span>
              <input value={img?.size ?? ''} placeholder={img?.mode === 'dashscope' ? '1328*1328' : '1024x1024'} onChange={(e) => patchImg({ size: e.target.value })} />
            </label>
          </div>
        )}

        {tab === 'token-plan' && (
          <div className="settings-section">
            <p className="section-hint">
              token-plan 是阿里云百炼的聚合 API：一个 Key 下挂多个模型（文本生成 / 生图 / 视频 / 语音 / Realtime-Chatting），单独配置。
              其中文本子模型会注册进模型路由，由主模型通过 pick_model 自行判断调用；生图 / 视频 / 语音分别启用 generate_image / generate_video / text_to_speech（均为 DashScope 原生协议）。
            </p>
            <label className="field">
              <span>API Key（token-plan 专用）</span>
              <input
                type="password"
                value={tokenPlan?.apiKey ?? ''}
                placeholder="sk-…"
                onChange={(e) => patchTokenPlan({ apiKey: e.target.value })}
              />
            </label>
            <label className="field">
              <span>Base URL（专用域名）</span>
              <input
                value={tokenPlan?.baseUrl ?? ''}
                placeholder={TOKEN_PLAN_ORIGIN}
                onChange={(e) => patchTokenPlan({ baseUrl: e.target.value })}
              />
            </label>

            <div className="tp-fetch-row">
              <button className="btn" onClick={loadTokenPlanModels} disabled={tpLoading}>
                {tpLoading ? '读取中…' : '从上游读取模型'}
              </button>
              <span className="section-hint">文本模型走 OpenAI 兼容 /models 实时读取，生图/视频/语音/Realtime 按官方清单回填。</span>
            </div>
            {tpError && <p className="tp-error">{tpError}</p>}

            <h4 className="sub-heading">文本生成子模型（由主模型选调）</h4>
            {tpText.map((m, idx) => (
              <div key={idx} className="sub-model-card">
                <div className="sub-model-head">
                  <span className="sub-idx">#{idx + 1}</span>
                  <button className="btn-link danger" onClick={() => removeTpText(idx)}>删除</button>
                </div>
                <div className="field-row">
                  <label className="field">
                    <span>模型 ID（唯一标识）</span>
                    <input value={m.id} placeholder="tp-code" onChange={(e) => patchTpText(idx, { id: e.target.value })} />
                  </label>
                  <label className="field">
                    <span>模型名</span>
                    <input value={m.model} placeholder="qwen-max" onChange={(e) => patchTpText(idx, { model: e.target.value })} />
                  </label>
                </div>
                <label className="field">
                  <span>显示名称（可选）</span>
                  <input value={m.label ?? ''} placeholder="通义千问" onChange={(e) => patchTpText(idx, { label: e.target.value })} />
                </label>
                <label className="field">
                  <span>能力标签（影响自动选择）</span>
                  <div className="cap-tags">
                    {CAPABILITY_OPTIONS.map((cap) => {
                      const active = (m.capabilities ?? []).includes(cap)
                      return (
                        <button
                          key={cap}
                          className={`cap-tag ${active ? 'active' : ''}`}
                          onClick={() => {
                            const caps = m.capabilities ?? []
                            patchTpText(idx, { capabilities: active ? caps.filter((c) => c !== cap) : [...caps, cap] })
                          }}
                        >
                          {CAPABILITY_LABELS[cap] ?? cap}
                        </button>
                      )
                    })}
                  </div>
                </label>
              </div>
            ))}
            <button className="btn add-sub" onClick={addTpText}>+ 添加文本子模型</button>

            <TpGroup
              title="生图模型"
              count={tpImage.length}
              open={tpOpenGroups.includes('image')}
              onToggle={() => toggleTpGroup('image')}
            >
              {tpImage.map((m, idx) => (
                <div key={idx} className="sub-model-card">
                  <div className="sub-model-head">
                    <span className="sub-idx">#{idx + 1}</span>
                    <button className="btn-link danger" onClick={() => removeTpImage(idx)}>删除</button>
                  </div>
                  <div className="field-row">
                    <label className="field">
                      <span>生图模型名</span>
                      <input value={m.model} placeholder="qwen-image / wan2.7-image" onChange={(e) => patchTpImage(idx, { model: e.target.value })} />
                    </label>
                    <label className="field">
                      <span>默认尺寸</span>
                      <input value={m.size ?? ''} placeholder="1328*1328" onChange={(e) => patchTpImage(idx, { size: e.target.value })} />
                    </label>
                  </div>
                </div>
              ))}
              <button className="btn add-sub" onClick={addTpImage}>+ 添加生图模型</button>
            </TpGroup>

            <TpGroup
              title="视频生成模型"
              count={tpVideo.length}
              open={tpOpenGroups.includes('video')}
              onToggle={() => toggleTpGroup('video')}
            >
              {tpVideo.map((m, idx) => (
                <div key={idx} className="sub-model-card">
                  <div className="sub-model-head">
                    <span className="sub-idx">#{idx + 1}</span>
                    <button className="btn-link danger" onClick={() => removeTpSimple('videoModels', idx)}>删除</button>
                  </div>
                  <div className="field-row">
                    <label className="field">
                      <span>视频模型名</span>
                      <input value={m.model} placeholder="wan2.7-t2v / happyhorse-1.1-t2v" onChange={(e) => patchTpSimple('videoModels', idx, { model: e.target.value })} />
                    </label>
                    <label className="field">
                      <span>显示名称（可选）</span>
                      <input value={m.label ?? ''} placeholder="视频生成" onChange={(e) => patchTpSimple('videoModels', idx, { label: e.target.value })} />
                    </label>
                  </div>
                </div>
              ))}
              <button className="btn add-sub" onClick={() => addTpSimple('videoModels')}>+ 添加视频生成模型</button>
            </TpGroup>

            <TpGroup
              title="语音模型"
              count={tpVoice.length}
              open={tpOpenGroups.includes('voice')}
              onToggle={() => toggleTpGroup('voice')}
            >
              {tpVoice.map((m, idx) => (
                <div key={idx} className="sub-model-card">
                  <div className="sub-model-head">
                    <span className="sub-idx">#{idx + 1}</span>
                    <button className="btn-link danger" onClick={() => removeTpSimple('voiceModels', idx)}>删除</button>
                  </div>
                  <div className="field-row">
                    <label className="field">
                      <span>语音模型名</span>
                      <input value={m.model} placeholder="qwen-tts" onChange={(e) => patchTpSimple('voiceModels', idx, { model: e.target.value })} />
                    </label>
                    <label className="field">
                      <span>显示名称（可选）</span>
                      <input value={m.label ?? ''} placeholder="语音合成" onChange={(e) => patchTpSimple('voiceModels', idx, { label: e.target.value })} />
                    </label>
                  </div>
                </div>
              ))}
              <button className="btn add-sub" onClick={() => addTpSimple('voiceModels')}>+ 添加语音模型</button>
            </TpGroup>

            <TpGroup
              title="Realtime-Chatting 模型"
              count={tpRealtime.length}
              open={tpOpenGroups.includes('realtime')}
              onToggle={() => toggleTpGroup('realtime')}
            >
              {tpRealtime.map((m, idx) => (
                <div key={idx} className="sub-model-card">
                  <div className="sub-model-head">
                    <span className="sub-idx">#{idx + 1}</span>
                    <button className="btn-link danger" onClick={() => removeTpSimple('realtimeModels', idx)}>删除</button>
                  </div>
                  <div className="field-row">
                    <label className="field">
                      <span>Realtime 模型名</span>
                      <input value={m.model} placeholder="qwen-realtime" onChange={(e) => patchTpSimple('realtimeModels', idx, { model: e.target.value })} />
                    </label>
                    <label className="field">
                      <span>显示名称（可选）</span>
                      <input value={m.label ?? ''} placeholder="实时对话" onChange={(e) => patchTpSimple('realtimeModels', idx, { label: e.target.value })} />
                    </label>
                  </div>
                </div>
              ))}
              <button className="btn add-sub" onClick={() => addTpSimple('realtimeModels')}>+ 添加 Realtime 模型</button>
            </TpGroup>
          </div>
        )}

        {tab === 'env' && (
          <div className="settings-section">
            <label className="field">
              <span>工作区（Agent 文件/命令操作的根目录）</span>
              <input value={form.workspace ?? ''} placeholder="绝对路径" onChange={(e) => setField('workspace', e.target.value)} />
            </label>
            <div className="ws-picker">
              <button className="btn" onClick={() => void pickWorkspace()}><Icon name="folder" /> 选择目录</button>
              <button className="btn" onClick={() => void applyTempWorkspace()}><Icon name="sparkle" /> 临时工作区</button>
            </div>
            <label className="field">
              <span>沙箱级别</span>
              <select value={form.level ?? 'workspace-write'} onChange={(e) => setField('level', e.target.value)}>
                <option value="workspace-write">workspace-write（工作区内可写，默认）</option>
                <option value="read-only">read-only（只读）</option>
              </select>
            </label>
          </div>
        )}

        {tab === 'specs' && <SpecPanel onToast={onToast} />}
        {tab === 'memory' && <MemoryPanel />}
        {tab === 'skills' && <SkillPanel />}
        {tab === 'tools' && <ToolPanel />}
        {tab === 'update' && <UpdatePanel />}

        <div className="modal-actions">
          <button className="btn" onClick={onClose}>
            取消
          </button>
          <button className="btn primary" onClick={save}>
            保存
          </button>
        </div>
      </div>
    </div>
  )
}
