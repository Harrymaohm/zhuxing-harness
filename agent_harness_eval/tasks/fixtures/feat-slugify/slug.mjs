/**
 * 演示模块：把标题转成 URL slug。
 * 当前只做小写化与空白替换，选项参数（separator / maxLength）尚未实现。
 */

/** 生成 slug。options 目前被忽略。 */
export function slugify(input) {
  return String(input).trim().toLowerCase().replace(/\s+/g, '-')
}
