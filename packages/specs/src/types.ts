/**
 * 专业化能力包（zip）类型定义。
 * 专业化包 = manifest.json + skills/*.yaml + knowledge/*.{md,txt,...}，
 * 面向专业用户（建筑 / 电网等），与普通增量更新包不同：
 * 安装后按领域启用，技能注册进技能系统，知识文档入库到知识库（带 specId 便于禁用时隔离）。
 */

/** 包内 manifest.json 结构（zip 根目录）。 */
export interface SpecManifest {
  /** 全局唯一 slug（字母数字与 -_）。 */
  id: string
  /** 显示名（如「建筑专业包」）。 */
  name: string
  /** 包版本（semver，可选）。 */
  version?: string
  /** 简介。 */
  description?: string
  /** 领域分类（如 建筑 / 电网 / 医疗）。 */
  category?: string
  /** 图标（可选，emoji 或图标名）。 */
  icon?: string
  /** 参与集成的技能文件名列表（相对 skills/ 目录）。缺省提取全部。 */
  skills?: string[]
  /** 参与入库的知识文件名列表（相对 knowledge/ 目录）。缺省提取全部。 */
  knowledge?: string[]
}

/** 已安装的专业化包记录（持久化到 ~/.zhuxing-harness/specs/index.json）。 */
export interface SpecRecord {
  id: string
  name: string
  version: string
  description?: string
  category?: string
  icon?: string
  /** 是否启用（启用后技能注册、知识参与检索）。 */
  enabled: boolean
  skillCount: number
  knowledgeCount: number
  installedAt: number
}

/** 专业化包管理器选项。 */
export interface SpecManagerOptions {
  /** 基础目录（缺省 ~/.zhuxing-harness/specs）。 */
  dir?: string
}

/** 包内文件清单（安装解析结果）。 */
export interface SpecContents {
  manifest: SpecManifest
  skills: Array<{ name: string; content: string }>
  knowledge: Array<{ name: string; content: string }>
}


/** 从 zip 解析出的清单结构（尚未落盘）。 */
export interface ParsedSpec {
  manifest: SpecManifest
  skills: Array<{ name: string; content: Buffer }>
  knowledge: Array<{ name: string; content: Buffer }>
}
