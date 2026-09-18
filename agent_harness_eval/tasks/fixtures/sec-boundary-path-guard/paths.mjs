/**
 * 演示模块：把用户提供的相对路径解析到工作区根目录下。
 * 缺陷：未拦截 `../` 穿越与绝对路径，用户输入可越出工作区。
 */

/** 解析路径。当前实现直接把字符串拼在 root 后面。 */
export function resolveInside(root, userPath) {
  return `${root}/${String(userPath)}`
}
