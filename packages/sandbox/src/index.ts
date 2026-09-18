import { realpathSync } from 'node:fs'
import { dirname, resolve as resolvePath, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { HarnessError } from '@zhuxing/harness-kernel'

/**
 * 权限分级：默认只读，写入/危险操作需审批。
 *
 * 级别名的单一事实来源在此处 —— CLI / Web / Runtime 一律引用本模块导出的常量，
 * 不再各自硬编码字符串，避免出现「某一处悄悄放宽为完全权限」的漂移。
 */
export const PERMISSION_LEVELS = ['read-only', 'workspace-write', 'danger-full-access'] as const
export type PermissionLevel = (typeof PERMISSION_LEVELS)[number]
/** 受限级别（不允许工作区外写入）：判定「是否完全放开」的单一事实来源。 */
export const RESTRICTED_PERMISSION_LEVELS: readonly string[] = ['read-only', 'workspace-write']
/** 默认级别：写操作限定在工作区内，需要完全放开时必须显式选择。 */
export const DEFAULT_PERMISSION_LEVEL: PermissionLevel = 'workspace-write'

/**
 * 凭据类文件名特征：读取一律拒绝（与沙箱等级无关）。
 *
 * 理由：写范围（能否写工作区外）与机密保密是两个正交的关注点。即便显式选择了
 * danger-full-access（放开写范围），也不应把私钥 / .env / secrets.* 当作普通文件读走，
 * 再经最终答复或外联通道流出。需要读取时由部署方通过 allowedReads 显式放行。
 */
const SENSITIVE_READ_PATTERNS = [
  /(^|[\\/])\.env(\.[^\\/]*)?$/i,
  /(^|[\\/])secrets?\.(json|ya?ml|env|txt|ini|conf)$/i,
  /(^|[\\/])id_(rsa|dsa|ecdsa|ed25519)(\.[^\\/]*)?$/i,
  /(^|[\\/])\.git-credentials$/i,
  /(^|[\\/])\.netrc$/i,
  /(^|[\\/])credentials(\.json|\.ya?ml)?$/i,
]

export interface SandboxPolicy {
  level: PermissionLevel
  /** 允许写入的工作区目录（workspace-write 生效）。 */
  workspace: string
  /** 额外放行的命令前缀（workspace-write / read-only 生效）。 */
  allowedCommands?: string[]
  /** 明确禁止的命令前缀（最高优先级）。 */
  deniedCommands?: string[]
  /** 显式放行的敏感读取路径前缀（默认空：凭据类文件一律不可读）。 */
  allowedReads?: string[]
}

/** 沙箱守卫：对命令 / 文件读取 / 文件写入做策略裁决。 */
export interface Sandbox {
  readonly policy: SandboxPolicy
  /** 检查命令是否被允许；不允许时抛错。 */
  checkCommand(command: string): void
  /** 检查路径是否可读；不可读时抛错。 */
  checkRead(path: string): void
  /** 检查路径是否可写；不可写时抛错。 */
  checkWrite(path: string): void
}

/**
 * 写类命令特征（read-only 禁止）。
 *
 * 原则：只拦截「明确的写意图」，不拦截「只读查询」。
 * - 纯查询命令（git status/log/diff、grep/find/cat/head/tail、sed 查询、awk 查询、npm view、pip list 等）默认放行；
 * - 写意图通过「命令特征」或「重定向（> / >>）」识别。
 */
const WRITE_COMMAND_PATTERNS = [
  /^(rm|rmdir|rd|ri|del|erase|unlink)\s/i,
  /^(mv|move|rename|ren)\s/i,
  /^(cp|copy|xcopy|robocopy)\s/i,
  /^(mkdir|md|touch|truncate|install)\s/i,
  /^ln\s/i,
  /^(new-item|ni)\s/i,
  /^(set-content|add-content|clear-content|out-file)\s/i,
  /^(remove-item)\s/i,
  /^echo[^|]*>\s/i, // echo 重定向写文件（echo 查询无 >，放行）
  /(^|[^0-9&|<>])>>?\s*\S/, // 通用重定向写（排除 2>&1 之类的 fd 复制与管道）
  /^(vi|vim|nvim|nano|emacs|ed)\s/i, // 交互式编辑
  /^sed\s+(-i|-E?ni|-in|-iE?n?)\b/i, // 仅 sed 原地写（-i）；sed 查询（无 -i）放行
  /^tee\s/i,
  /^(chmod|chown|chattr|attrib|icacls)\s/i,
  /^git\s+(push|commit|tag|checkout|reset|clean|restore|apply)(\s|$)/i, // git 只读子命令放行
  /^(pip|pip3)\s+(install|uninstall)/i,
  /^(npm|pnpm|yarn|bun)\s+(install|i|add|publish|uninstall|remove|rm)(\s|$)/i,
  /^(npm|pnpm|yarn|bun)\s+run\s/i,
  /^curl\s+[-]?.*-o/i, // curl 下载写文件（纯查询 curl 放行）
  /^wget\s/i,
  /^dd\s/i,
  /^mkfs/i,
  /^format\s/i,
]

/** shell 包装器：取出内层命令，避免 `sh -c "rm -rf x"` 之类绕过前缀/特征判定。 */
const SHELL_WRAPPERS = [
  /^(?:\/bin\/)?(?:ba|z|da)?sh\s+-c\s+([\s\S]+)$/i,
  /^cmd(?:\.exe)?\s+\/c\s+([\s\S]+)$/i,
  /^(?:powershell(?:\.exe)?|pwsh)\s+(?:-[\w-]+\s+)*-c(?:ommand)?\s+([\s\S]+)$/i,
  /^env\s+(?:[\w-]+=\S+\s+)*([\s\S]+)$/i,
]

function stripQuotes(s: string): string {
  const t = s.trim()
  if (t.length >= 2 && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")) || (t.startsWith('`') && t.endsWith('`')))) {
    return t.slice(1, -1).trim()
  }
  return t
}

/** 逐层剥离 shell 包装器（最多 3 层），返回所有可判定的命令形态。 */
function commandForms(command: string): string[] {
  const forms = [command]
  let cur = command
  for (let i = 0; i < 3; i++) {
    const unwrapped = stripQuotes(cur)
    if (unwrapped !== cur) {
      cur = unwrapped
      forms.push(cur)
      continue
    }
    let matched = false
    for (const w of SHELL_WRAPPERS) {
      const m = w.exec(cur)
      if (m && m[1]) {
        cur = m[1].trim()
        forms.push(cur)
        matched = true
        break
      }
    }
    if (!matched) break
  }
  return forms
}

/** 判断命令（含包装器内层形态）是否命中写类特征。 */
function findWriteIntent(command: string): string | undefined {
  for (const form of commandForms(command)) {
    for (const pattern of WRITE_COMMAND_PATTERNS) {
      if (pattern.test(form)) return form
    }
  }
  return undefined
}

/**
 * 判定路径是否属于凭据类敏感文件。
 *
 * 与 checkRead 共用同一判据：任何「读文件内容」的通道（read_file / search_files 等）
 * 都必须用本函数过滤，避免只堵住其中一个入口。
 */
export function isSensitiveReadPath(input: string): boolean {
  return SENSITIVE_READ_PATTERNS.some((re) => re.test(normalizePath(input)))
}

/** 归一化路径：解析 file:// URL → 绝对路径 → Windows 大小写归一。 */
function normalizePath(input: string): string {
  let p = input.trim()
  if (/^file:\/\//i.test(p)) {
    try {
      p = fileURLToPath(p)
    } catch {
      p = p.replace(/^file:\/\/+/, '')
    }
  }
  let abs = resolvePath(p)
  if (process.platform === 'win32') abs = abs.toLowerCase()
  return abs
}

/** 解析符号链接：对「最深的已存在祖先」取 realpath，用于消除 symlink 逃逸。 */
function realpathDeepest(abs: string): string {
  let cur = abs
  for (;;) {
    try {
      const real = realpathSync.native ? realpathSync.native(cur) : realpathSync(cur)
      return process.platform === 'win32' ? real.toLowerCase() : real
    } catch {
      const parent = dirname(cur)
      if (!parent || parent === cur) return abs
      cur = parent
    }
  }
}

/** 判定 target 是否落在 workspace 之内（分隔符边界 + 符号链接归一）。 */
function isInsideWorkspace(target: string, workspace: string): boolean {
  const ws = realpathDeepest(normalizePath(workspace))
  const abs = realpathDeepest(normalizePath(target))
  return abs === ws || abs.startsWith(ws.endsWith(sep) ? ws : ws + sep)
}

export class SandboxImpl implements Sandbox {
  constructor(readonly policy: SandboxPolicy) {}

  checkCommand(command: string): void {
    const trimmed = command.trim()
    if (!trimmed) return
    const forms = commandForms(trimmed)
    // 明确禁止优先（同时校验 shell 包装器内层形态，避免 `sh -c "rm -rf x"` 绕过前缀）
    for (const denied of this.policy.deniedCommands ?? []) {
      if (forms.some((form) => form.startsWith(denied))) {
        throw new HarnessError(
          `[sandbox] 命令被策略禁止：${denied}（deniedCommands）`,
          'PERMISSION',
          `命令 "${trimmed.slice(0, 50)}" 被沙箱策略禁止。`,
        )
      }
    }
    if (this.policy.level === 'danger-full-access') return
    // 放行列表优先
    for (const allowed of this.policy.allowedCommands ?? []) {
      if (forms.some((form) => form.startsWith(allowed))) return
    }
    // read-only 与 workspace-write 均拒绝「明确的写意图」：写路径仍由 checkWrite 裁决归属。
    const hit = findWriteIntent(trimmed)
    if (hit) {
      throw new HarnessError(
        `[sandbox] ${this.policy.level} 策略禁止写类命令：${hit.slice(0, 60)}`,
        'PERMISSION',
        this.policy.level === 'read-only'
          ? '当前为 read-only 沙箱。如需执行写操作，请使用 --level workspace-write。'
          : '当前为 workspace-write 沙箱，写操作请通过 write_file 等受控写工具在workspace 内完成，禁止通过 shell 直接写盘。',
      )
    }
    // 其余命令放行
  }

  checkRead(path: string): void {
    const target = normalizePath(path)
    // 显式放行优先（部署方明确知道的凭据路径）
    for (const allowed of this.policy.allowedReads ?? []) {
      const prefix = normalizePath(allowed)
      if (target === prefix || target.startsWith(prefix.endsWith(sep) ? prefix : prefix + sep)) return
    }
    // 凭据类文件：任意等级下都拒绝读取（写范围与机密保密正交）
    if (SENSITIVE_READ_PATTERNS.some((re) => re.test(target))) {
      throw new HarnessError(
        `[sandbox] 拒绝读取凭据类文件：${path}`,
        'PERMISSION',
        '私钥 / .env / secrets.* 等凭据文件不通过工具读取（与沙箱等级无关）。确需读取请在策略中显式配置 allowedReads。',
      )
    }
  }

  checkWrite(path: string): void {
    if (this.policy.level === 'danger-full-access') return
    if (this.policy.level === 'read-only') {
      throw new HarnessError(
        `[sandbox] read-only 策略禁止写入：${path}`,
        'PERMISSION',
        '当前为 read-only 沙箱，拒绝写入。可改用 workspace-write 级别限制在工作区内写入。',
      )
    }
    // workspace-write：路径归一化（file:// → 绝对路径 → 折叠 .. → 解析符号链接）后做分隔符边界判定
    if (!isInsideWorkspace(path, this.policy.workspace)) {
      throw new HarnessError(
        `[sandbox] workspace-write 策略禁止写入工作区外路径：${path}`,
        'PERMISSION',
        'workspace-write 只允许写入工作区内路径（已按 .. / 符号链接归一化判定）。',
      )
    }
  }
}

export function createSandbox(policy: SandboxPolicy): Sandbox {
  return new SandboxImpl(policy)
}
