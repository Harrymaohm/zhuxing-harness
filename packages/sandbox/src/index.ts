/** 权限分级：默认只读，写入/危险操作需审批。 */
export type PermissionLevel = 'read-only' | 'workspace-write' | 'danger-full-access'

import { HarnessError } from '@zhuxing/harness-kernel'

export interface SandboxPolicy {
  level: PermissionLevel
  /** 允许写入的工作区目录（workspace-write 生效）。 */
  workspace: string
  /** 额外放行的命令前缀（workspace-write / read-only 生效）。 */
  allowedCommands?: string[]
  /** 明确禁止的命令前缀（最高优先级）。 */
  deniedCommands?: string[]
}

/** 沙箱守卫：对命令 / 文件写入做策略裁决。 */
export interface Sandbox {
  readonly policy: SandboxPolicy
  /** 检查命令是否被允许；不允许时抛错。 */
  checkCommand(command: string): void
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
  /^rm\s/i,
  /^rmdir\s/i,
  /^mv\s/i,
  /^cp\s/i,
  /^mkdir\s/i,
  /^touch\s/i,
  /^echo[^|]*>\s/i, // echo 重定向写文件（echo 查询无 >，放行）
  />>/,
  /^(vi|vim|nano|ed)\s/i, // 交互式编辑
  /^sed\s+(-i|-E?ni|-in|-iE?n?)\b/i, // 仅 sed 原地写（-i）；sed 查询（无 -i）放行
  /^chmod\s/i,
  /^chown\s/i,
  /^git\s+(push|commit|tag)(\s|$)/i, // git 只读子命令（status/log/diff/fetch 除外）放行
  /^pip\s+install/i,
  /^npm\s+(install|publish|run\s)/i,
  /^pnpm\s+(install|publish|run\s)/i,
  /^yarn\s+(add|install|publish|run\s)/i,
  /^curl\s+[-]?.*-o/i, // curl 下载写文件（纯查询 curl 放行）
  /^wget\s/i,
  /^dd\s/i,
  /^mkfs/i,
  /^format/i,
]

export class SandboxImpl implements Sandbox {
  constructor(readonly policy: SandboxPolicy) {}

  checkCommand(command: string): void {
    const trimmed = command.trim()
    if (!trimmed) return
    // 明确禁止优先
    for (const denied of this.policy.deniedCommands ?? []) {
      if (trimmed.startsWith(denied)) {
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
      if (trimmed.startsWith(allowed)) return
    }
    if (this.policy.level === 'read-only') {
      for (const pattern of WRITE_COMMAND_PATTERNS) {
        if (pattern.test(trimmed)) {
          throw new HarnessError(
            `[sandbox] read-only 策略禁止写类命令：${trimmed.slice(0, 60)}`,
            'PERMISSION',
            '当前为 read-only 沙箱。如需执行写操作，请使用 --level workspace-write 或 danger-full-access。',
          )
        }
      }
    }
    // workspace-write：命令放行，写路径由 checkWrite 裁决
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
    // workspace-write：仅允许工作区内的相对/绝对路径
    const workspace = this.policy.workspace.replace(/[\\/]+$/, '')
    const abs = path.replace(/^file:\/\//, '')
    if (!abs.startsWith(workspace)) {
      throw new HarnessError(
        `[sandbox] workspace-write 策略禁止写入工作区外路径：${path}`,
        'PERMISSION',
        'workspace-write 只允许写入工作区内路径，可改用 danger-full-access 放开。',
      )
    }
  }
}

export function createSandbox(policy: SandboxPolicy): Sandbox {
  return new SandboxImpl(policy)
}
