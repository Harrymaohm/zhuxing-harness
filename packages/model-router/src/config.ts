import type { ModelConfigEntry } from './types.js'

/**
 * 解析配置里的 `models` 字段：全仓**唯一**的模型配置解析实现。
 *
 * 为什么放在这里而不是各调用方自己写：CLI、Web 后端、内核 runtime 三处的配置都长这个形状，
 * 此前各自抄了一份逐字相同的实现（cli 的 parseModelsConfig / web 的 parseWebModels /
 * runtime 的 parseRuntimeModels）。配置格式一旦演进（例如新增字段校验、换存储形式），
 * 三份拷贝必然分叉，典型症状是「CLI 认为配置合法、runtime 却解析不出来」——这类问题
 * 排查成本极高，因为它只在特定入口复现。
 *
 * `ModelConfigEntry` 本就定义在本包，三个调用方也都已依赖本包，因此这里是最自然的归属。
 *
 * 容错策略：未配置 → undefined；JSON 串解析失败或解析结果不是数组 → undefined
 * （都按「没配」处理，由调用方各自决定回退到默认模型）。
 *
 * 入参故意收成 `unknown`：三个调用方的配置类型各不相同——CLI 的 HarnessConfig 是带索引签名的
 * 弱类型、Web 与 runtime 的是显式声明 `models?: ModelConfigEntry[] | string`。收成具体形状
 * 会让其中一方无法传入（弱类型检查），收成 unknown 再由这里自行收窄才是通用解。
 */
export function parseModelsConfig(config: unknown): ModelConfigEntry[] | undefined {
  if (!config || typeof config !== 'object') return undefined
  const raw = (config as Record<string, unknown>).models
  if (!raw) return undefined
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw
    return Array.isArray(parsed) ? (parsed as ModelConfigEntry[]) : undefined
  } catch {
    return undefined
  }
}
