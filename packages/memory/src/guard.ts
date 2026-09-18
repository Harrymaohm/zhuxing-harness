/**
 * 跨会话记忆写入安全闸（memory write guard）。
 *
 * 设计前提：**记忆是数据，不是指令**。跨会话记忆（user / project / auto）会在后续会话中
 * 注入 systemPrompt，一旦落库就会被长期放大（持久化注入、跨会话劫持）。
 *
 * 本闸对写入内容做语义分类，命中以下任一类别即判定为「指令性内容」而非「事实 / 偏好」，
 * 拒绝跨会话持久化（调用方可改用 scope=session：对话私有，不注入后续会话）：
 *  1. instruction-override   指令覆盖 / 优先级篡改（忽略上文、新指令优先、覆盖系统提示）
 *  2. authority-spoof        冒充系统 / 管理员 / 开发者权威
 *  3. concealment            要求对用户隐瞒或跳过确认
 *  4. goal-replacement       借「上下文压缩 / 目标失效」替换目标
 *  5. persistent-instruction 要求跨会话持续执行动作
 *  6. executable-payload     携带可执行载荷或外泄目标（run: / copy … to … / {"action":…}）
 *
 * 局限（如实声明）：这是**启发式语义闸**，不是完备判定，改写表述即可绕过。
 * 它是纵深防御中的一层，不能替代「跨会话记忆写入需人工确认」的产品级审批通道。
 */
export interface MemoryScanResult {
  /** 内容是否可作为跨会话记忆写入。 */
  safe: boolean
  /** 命中的类别 id（safe 时为空数组）。 */
  categories: string[]
  /** 面向调用方的拒绝原因（safe 时为 undefined）。 */
  reason?: string
}

interface Rule {
  category: string
  label: string
  re: RegExp
}

const RULES: Rule[] = [
  // 1. 指令覆盖 / 优先级篡改
  {
    category: 'instruction-override',
    label: '指令覆盖 / 优先级篡改',
    re: /(忽略|无视|作废|废弃|覆盖).{0,10}(上文|之前|以上|先前|原有|所有|全部|沙箱|安全|系统)?.{0,6}(指令|策略|规则|限制|提示|要求|设定)/i,
  },
  {
    category: 'instruction-override',
    label: '指令覆盖 / 优先级篡改',
    re: /(新|以下|下面|上述)的?指令.{0,6}(优先|覆盖|生效)|指令.{0,4}优先于/i,
  },
  {
    category: 'instruction-override',
    label: '指令覆盖 / 优先级篡改',
    re: /\b(ignore|disregard|override)\b[^.\n]{0,30}\b(previous|prior|above|earlier|system|all)\b/i,
  },
  {
    category: 'instruction-override',
    label: '指令覆盖 / 优先级篡改',
    re: /\bif you (can )?(read|see) this\b/i,
  },
  // 2. 冒充系统 / 权威
  {
    category: 'authority-spoof',
    label: '冒充系统 / 权威',
    re: /(^|[\s>（(【[])(system|assistant|developer|root|admin|系统|管理员|开发者)\s*[:：]/i,
  },
  {
    category: 'authority-spoof',
    label: '冒充系统 / 权威',
    re: /\bas an? (administrator|admin|developer|system|operator)\b/i,
  },
  { category: 'authority-spoof', label: '冒充系统 / 权威', re: /\bDAN\b|无限制(助手|模式)|越狱/ },
  // 3. 要求隐瞒 / 跳过确认
  {
    category: 'concealment',
    label: '要求隐瞒 / 跳过确认',
    re: /(不要|不用|别|无需|不必|禁止)(向)?(用户|使用者)?(提示|告知|告诉|通知|提及|汇报|确认|声张)/,
  },
  {
    category: 'concealment',
    label: '要求隐瞒 / 跳过确认',
    re: /\b(do not|don't|without)\b[^.\n]{0,24}\b(tell|inform|mention|notify|ask|confirm)\w*/i,
  },
  { category: 'concealment', label: '要求隐瞒 / 跳过确认', re: /"silent"\s*:\s*true|静默(执行|处理|完成)/i },
  // 4. 替换目标
  {
    category: 'goal-replacement',
    label: '替换目标',
    re: /(上下文|记忆|对话)(被)?压缩.{0,20}(丢失|忘记|失效|重来)|(丢失|忘记|偏离)了?(原)?(任务|目标)|(新|唯一)的?目标(是|为)/,
  },
  { category: 'goal-replacement', label: '替换目标', re: /(不(是|再是)重点|不重要了|先不(管|做)|别管了?|作废)/ },
  // 5. 跨会话持续执行
  {
    category: 'persistent-instruction',
    label: '跨会话持续执行',
    re: /(今后|以后|从今|自此|后续|接下来|每次|永远).{0,12}(都|一律|必须|始终|自动).{0,6}(执行|运行|写入|上传|删除|调用|复制|发送)/,
  },
  {
    category: 'persistent-instruction',
    label: '跨会话持续执行',
    re: /\bfrom now on\b|\bwhenever\b|\balways (run|use|execute|do|append|write)\b/i,
  },
  {
    category: 'persistent-instruction',
    label: '跨会话持续执行',
    re: /(必须|务必|立即|马上|立刻).{0,8}(执行|运行|写入|上传|删除|调用|复制)/,
  },
  // 6. 携带可执行载荷 / 外泄目标
  {
    category: 'executable-payload',
    label: '携带可执行载荷 / 外泄目标',
    re: /\b(run|execute|exec|invoke|copy|cp|move|mv|dump|upload|exfiltrate|delete|rm|del|curl|wget|echo)\b\s*[:：]/i,
  },
  {
    category: 'executable-payload',
    label: '携带可执行载荷 / 外泄目标',
    re: /\b(append|write|copy|cp|move|mv|dump|upload|send|post|save|echo)\b[^.\n]{0,48}\b(to|into|onto)\b\s*\S/i,
  },
  {
    category: 'executable-payload',
    label: '携带可执行载荷 / 外泄目标',
    re: /"action"\s*:\s*"|exfiltrat|"target"\s*:\s*"/i,
  },
  {
    category: 'executable-payload',
    label: '携带可执行载荷 / 外泄目标',
    re: /(写入|写到|写进|复制到|移动到|上传到|发送到|贴到|存到|拷到|删除|清空).{0,24}([A-Za-z]:[\\/]|\/[\w.-]+\/|文件|目录|路径)/,
  },
  {
    category: 'executable-payload',
    label: '携带可执行载荷 / 外泄目标',
    re: /(执行|运行).{0,6}(其中|以下|下面|上述)?.{0,4}(命令|脚本)/,
  },
]

/**
 * 扫描待写入的记忆内容。
 * @param content 记忆正文
 * @param scope 目标作用域；session 为对话私有，不跨会话注入，无需过闸
 */
export function scanMemoryContent(content: string, scope?: string): MemoryScanResult {
  const text = String(content ?? '')
  if (!text.trim() || scope === 'session') return { safe: true, categories: [] }
  const hits: Rule[] = RULES.filter((r) => r.re.test(text))
  if (hits.length === 0) return { safe: true, categories: [] }
  const categories = [...new Set(hits.map((h) => h.category))]
  const labels = [...new Set(hits.map((h) => h.label))]
  return {
    safe: false,
    categories,
    reason:
      `跨会话记忆不接受指令性内容（命中：${labels.join('、')}）。` +
      '记忆只应沉淀事实与偏好；若确需保留在本次对话，请改用 scope=session（不跨会话注入）。',
  }
}
