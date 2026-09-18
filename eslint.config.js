import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import tseslint from 'typescript-eslint'

/**
 * ESLint 配置：**只做正确性检查，不碰格式**。
 *
 * 为什么这么窄：
 * - 格式化（缩进/引号/换行）不引入 Prettier——那会对全仓两万行产生一次无信息量的重排 diff，
 *   收益是"风格统一"，代价是 review 全部失效。风格继续靠既有约定 + review 保持。
 * - 规则集不用 `recommended` 的全量清单，只留能指出**真实缺陷**的那些：React Hooks 调用规则、
 *   无法到达的代码、重复键、空 catch 块等。类型层面上 tsc（strict + noUnusedLocals）已经把关，
 *   这里不重复它的工作，只补它覆盖不到的地方。
 *
 * 覆盖范围的真正增量在**非 TS 文件**：仓库脚本、桌面主进程（.cjs）、评测目录下的 .mjs、
 * 各包 bin 目录下的 .mjs，都不在 tsc 的编译范围里，过去**完全没有**任何静态检查。
 * 桌面主进程与评测工具恰恰都在这些文件里。
 */
export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/dist-bin/**',
      '**/dist-ui/**',
      '**/dist-install/**',
      '**/dist-installer/**',
      '**/dist-update/**',
      '**/coverage/**',
      '**/.work/**',
      '**/.harness-cache/**',
      'agent_harness_eval/out*/**',
      // 临时验证目录（.gitignore 已忽略，属一次性产物而非源码）
      '_pptx_test/**',
      // 打包/临时产物目录（内含生成的 .cjs/.nsi，不是源码）
      'packages/desktop/dist-installer/**',
      'scripts/nsis/**',
      // 用户可安装的插件与工具目录（第三方代码，不按本仓规范约束）
      'plugins/**',
      'tools/**',
    ],
  },

  // 全仓基础：核心正确性规则 + Node 环境全局变量
  {
    files: ['**/*.{js,mjs,cjs,ts,tsx}'],
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      ...js.configs.recommended.rules,
      // TS 负责重复声明/未定义标识符的判定，ESLint 的这两条在 TS 下会误报（类型位置、declare 等）
      'no-undef': 'off',
      'no-redeclare': 'off',
      // 空块往往是有意为之（best-effort 清理），但**空的 catch** 通常意味着吞错
      'no-empty': ['error', { allowEmptyCatch: false }],
      // 允许以 _ 开头的显式忽略参数
      'no-unused-vars': 'off',
    },
  },

  // TS/TSX：类型感知的推荐规则里只保留不依赖类型信息的部分
  ...tseslint.configs.recommended.map((cfg) => ({
    ...cfg,
    files: ['**/*.{ts,tsx}'],
    rules: {
      ...cfg.rules,
      // tsc 的 noUnusedLocals/noUnusedParameters 已经把关，ESLint 这条会与之给出不同口径的噪音
      '@typescript-eslint/no-unused-vars': 'off',
      // 少数「确实只能用 any 的库桩/边界」场景允许带注释豁免，不设为 error 挡住正常开发
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  })),

  // React 前端：Hooks 调用规则是这里唯一无法被 tsc 替代的正确性检查
  {
    files: ['packages/web/ui/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },

  // 非 TS 文件（脚本 / 评测工具 / 桌面主进程）：这些文件不在 tsc 范围内，
  // 只有 ESLint 会看它们，因此这里保留未使用变量检查。
  {
    files: ['**/*.{js,mjs,cjs}'],
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
)
