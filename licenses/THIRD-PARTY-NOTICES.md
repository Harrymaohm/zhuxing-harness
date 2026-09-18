# 第三方依赖与许可证声明

> 本文件由 `node scripts/gen-licenses.mjs` 基于 `pnpm licenses list` 的**实测安装结果**生成，请勿手工编辑。

- 项目：Zhuxing Harness v0.4.0（自身许可见仓库根目录 [LICENSE](../LICENSE)：源码可用 · 非商业免费 · 商业付费授权）
- 统计：**576** 个第三方包，覆盖 **21** 种许可证
- 生成日期：2026-09-18
- 范围：pnpm workspace 实际安装的全部依赖，**含传递依赖与开发依赖**（开发依赖虽不进发行物，但参与构建链路，一并声明）

## 一、按许可证汇总

| 许可证 | 包数 | 分发时的义务 |
| --- | ---: | --- |
| `Artistic-2.0` | 5 | ⚠ 需评估 |
| `CC-BY-3.0` | 1 | ⚠ 需评估 |
| `CC-BY-4.0` | 1 | ⚠ 需评估 |
| `MPL-2.0` | 1 | ⚠ 需评估 |
| `Python-2.0` | 1 | ⚠ 需评估 |
| `MIT` | 430 | 需保留声明 |
| `Apache-2.0` | 38 | 需保留声明 |
| `ISC` | 36 | 需保留声明 |
| `BSD-2-Clause` | 21 | 需保留声明 |
| `BSD-3-Clause` | 18 | 需保留声明 |
| `BlueOak-1.0.0` | 11 | 需保留声明 |
| `BSD` | 1 | 需保留声明 |
| `CC0-1.0` | 2 | 免声明 |
| `MIT-0` | 2 | 免声明 |
| `WTFPL` | 2 | 免声明 |
| `(MIT AND Zlib)` | 1 | 表达式 |
| `(MIT OR CC0-1.0)` | 1 | 表达式 |
| `(MIT OR GPL-3.0-or-later)` | 1 | 表达式 |
| `(WTFPL OR MIT)` | 1 | 表达式 |
| `0BSD` | 1 | 免声明 |
| `WTFPL OR ISC` | 1 | 表达式 |

## 二、义务说明

- **需保留声明**：MIT / ISC / BSD / Apache-2.0 / BlueOak / Python-2.0 / Artistic-2.0 等要求随分发物保留版权与许可声明。
  各依赖的完整原文见其包内 `LICENSE` 文件；代表性全文同时收录在 [texts/](./texts) 目录。
- **免声明**：0BSD / CC0-1.0 / MIT-0 / WTFPL 不要求保留声明（仍然列出，便于自查）。
- **需评估**：MPL-2.0（弱著佐权，修改其文件需回馈）、CC-BY-*（署名要求，多用于数据包）、
  Python-2.0 / Artistic-2.0（较老的非标准条款）。当前用法均为**未修改地作为依赖使用**，不触发额外义务；
  若将来要修改这些包或用其代码派生，需重新评估。
- **表达式**：形如 `(MIT OR CC0-1.0)` 的双许可，可择一遵守。

## 三、完整清单

### Artistic-2.0（5 个，⚠ 需评估）

| 包 | 版本 | 作者 | 仓库 / 主页 |
| --- | --- | --- | --- |
| `binaryextensions` | 6.11.0 | Benjamin Lupton | <https://github.com/bevry/binaryextensions> |
| `editions` | 6.22.0 | Benjamin Lupton | <https://github.com/bevry/editions> |
| `istextorbinary` | 9.5.0 | Benjamin Lupton | <https://github.com/bevry/istextorbinary> |
| `textextensions` | 6.11.0 | Benjamin Lupton | <https://github.com/bevry/textextensions> |
| `version-range` | 4.15.0 | Benjamin Lupton | <https://github.com/bevry/version-range> |

### CC-BY-3.0（1 个，⚠ 需评估）

| 包 | 版本 | 作者 | 仓库 / 主页 |
| --- | --- | --- | --- |
| `spdx-exceptions` | 2.5.0 | The Linux Foundation | <https://github.com/kemitchell/spdx-exceptions.json#readme> |

### CC-BY-4.0（1 个，⚠ 需评估）

| 包 | 版本 | 作者 | 仓库 / 主页 |
| --- | --- | --- | --- |
| `caniuse-lite` | 1.0.30001809 | Ben Briggs | <https://github.com/browserslist/caniuse-lite#readme> |

### MPL-2.0（1 个，⚠ 需评估）

| 包 | 版本 | 作者 | 仓库 / 主页 |
| --- | --- | --- | --- |
| `axe-core` | 4.13.0 |  | <https://www.deque.com/axe/> |

### Python-2.0（1 个，⚠ 需评估）

| 包 | 版本 | 作者 | 仓库 / 主页 |
| --- | --- | --- | --- |
| `argparse` | 2.0.1 |  | <https://github.com/nodeca/argparse#readme> |

### MIT（430 个，需保留声明）

| 包 | 版本 | 作者 | 仓库 / 主页 |
| --- | --- | --- | --- |
| `@adobe/css-tools` | 4.5.0 | TJ Holowaychuk | <https://github.com/adobe/css-tools#readme> |
| `@asamuzakjp/css-color` | 6.0.7 | asamuzaK | <https://github.com/asamuzaK/cssColor#readme> |
| `@asamuzakjp/dom-selector` | 8.3.2 | asamuzaK | <https://github.com/asamuzaK/domSelector#readme> |
| `@babel/code-frame` | 7.29.7 | The Babel Team | <https://babel.dev/docs/en/next/babel-code-frame> |
| `@babel/compat-data` | 7.29.7 | The Babel Team | <https://github.com/babel/babel#readme> |
| `@babel/core` | 7.29.7 | The Babel Team | <https://babel.dev/docs/en/next/babel-core> |
| `@babel/generator` | 7.29.8 | The Babel Team | <https://babel.dev/docs/en/next/babel-generator> |
| `@babel/helper-compilation-targets` | 7.29.7 | The Babel Team | <https://github.com/babel/babel#readme> |
| `@babel/helper-globals` | 7.29.7 | The Babel Team | <https://github.com/babel/babel#readme> |
| `@babel/helper-module-imports` | 7.29.7 | The Babel Team | <https://babel.dev/docs/en/next/babel-helper-module-imports> |
| `@babel/helper-module-transforms` | 7.29.7 | The Babel Team | <https://babel.dev/docs/en/next/babel-helper-module-transforms> |
| `@babel/helper-plugin-utils` | 7.29.7 | The Babel Team | <https://babel.dev/docs/en/next/babel-helper-plugin-utils> |
| `@babel/helper-string-parser` | 7.29.7 | The Babel Team | <https://babel.dev/docs/en/next/babel-helper-string-parser> |
| `@babel/helper-validator-identifier` | 7.29.7 | The Babel Team | <https://github.com/babel/babel#readme> |
| `@babel/helper-validator-option` | 7.29.7 | The Babel Team | <https://github.com/babel/babel#readme> |
| `@babel/helpers` | 7.29.7 | The Babel Team | <https://babel.dev/docs/en/next/babel-helpers> |
| `@babel/parser` | 7.29.8 | The Babel Team | <https://babel.dev/docs/en/next/babel-parser> |
| `@babel/plugin-transform-react-jsx-self` | 7.29.7 | The Babel Team | <https://babel.dev/docs/en/next/babel-plugin-transform-react-jsx-self> |
| `@babel/plugin-transform-react-jsx-source` | 7.29.7 | The Babel Team | <https://babel.dev/docs/en/next/babel-plugin-transform-react-jsx-source> |
| `@babel/runtime` | 7.29.7 | The Babel Team | <https://babel.dev/docs/en/next/babel-runtime> |
| `@babel/template` | 7.29.7 | The Babel Team | <https://babel.dev/docs/en/next/babel-template> |
| `@babel/traverse` | 7.29.8 | The Babel Team | <https://babel.dev/docs/en/next/babel-traverse> |
| `@babel/types` | 7.29.8 | The Babel Team | <https://babel.dev/docs/en/next/babel-types> |
| `@bcoe/v8-coverage` | 1.0.2 | Charles Samborski | <https://github.com/bcoe/v8-coverage#readme> |
| `@bramus/specificity` | 2.4.2 | Bramus Van Damme | <https://github.com/bramus/specificity#readme> |
| `@cacheable/memory` | 2.2.0 | Jared Wray | <https://github.com/jaredwray/cacheable#readme> |
| `@cacheable/utils` | 2.5.0 | Jared Wray | <https://github.com/jaredwray/cacheable#readme> |
| `@csstools/css-calc` | 3.4.0 |  | <https://github.com/csstools/postcss-plugins/tree/main/packages/css-calc#readme> |
| `@csstools/css-color-parser` | 4.2.3 |  | <https://github.com/csstools/postcss-plugins/tree/main/packages/css-color-parser#readme> |
| `@csstools/css-parser-algorithms` | 4.0.0 |  | <https://github.com/csstools/postcss-plugins/tree/main/packages/css-parser-algorithms#readme> |
| `@csstools/css-tokenizer` | 4.0.0 |  | <https://github.com/csstools/postcss-plugins/tree/main/packages/css-tokenizer#readme> |
| `@electron/asar` | 3.4.1 |  | <https://github.com/electron/asar> |
| `@electron/fuses` | 1.8.0 | Electron Community | <https://github.com/electron/fuses#readme> |
| `@electron/get` | 2.0.3, 3.1.0 | Samuel Attard | <https://github.com/electron/get#readme> |
| `@electron/notarize` | 2.5.0 | Samuel Attard | <https://github.com/electron/notarize#readme> |
| `@electron/rebuild` | 4.2.0 |  | <https://github.com/electron/rebuild> |
| `@electron/universal` | 2.0.3 | Samuel Attard | <https://github.com/electron/universal#readme> |
| `@esbuild/win32-x64` | 0.25.12, 0.28.2 |  | <https://github.com/evanw/esbuild#readme> |
| `@eslint-community/eslint-utils` | 4.10.1 | Toru Nagashima | <https://github.com/eslint-community/eslint-utils#readme> |
| `@eslint-community/regexpp` | 4.12.2 | Toru Nagashima | <https://github.com/eslint-community/regexpp#readme> |
| `@eslint/js` | 10.0.1 |  | <https://eslint.org> |
| `@exodus/bytes` | 1.15.1 | Exodus Movement, Inc. | <https://github.com/ExodusOSS/bytes> |
| `@istanbuljs/schema` | 0.1.6 | Corey Farrell | <https://github.com/istanbuljs/schema#readme> |
| `@jridgewell/gen-mapping` | 0.3.13 | Justin Ridgewell | <https://github.com/jridgewell/sourcemaps/tree/main/packages/gen-mapping> |
| `@jridgewell/remapping` | 2.3.5 | Justin Ridgewell | <https://github.com/jridgewell/sourcemaps/tree/main/packages/remapping> |
| `@jridgewell/resolve-uri` | 3.1.2 | Justin Ridgewell | <https://github.com/jridgewell/resolve-uri#readme> |
| `@jridgewell/sourcemap-codec` | 1.5.5 | Justin Ridgewell | <https://github.com/jridgewell/sourcemaps/tree/main/packages/sourcemap-codec> |
| `@jridgewell/trace-mapping` | 0.3.31 | Justin Ridgewell | <https://github.com/jridgewell/sourcemaps/tree/main/packages/trace-mapping> |
| `@keyv/bigmap` | 1.3.1 | Jared Wray | <https://github.com/jaredwray/keyv> |
| `@keyv/serialize` | 1.1.1 | Jared Wray | <https://github.com/jaredwray/keyv> |
| `@malept/flatpak-bundler` | 0.4.0 | Matt Watson | <https://github.com/malept/flatpak-bundler#readme> |
| `@noble/hashes` | 1.4.0, 2.4.0 | Paul Miller | <https://paulmillr.com/noble/> |
| `@peculiar/asn1-schema` | 2.9.4 | PeculiarVentures, LLC | <https://github.com/PeculiarVentures/asn1-schema/tree/master/packages/schema#readme> |
| `@peculiar/json-schema` | 1.1.12 | PeculiarVentures, Inc | <https://github.com/PeculiarVentures/json-schema#readme> |
| `@peculiar/utils` | 2.0.3 | PeculiarVentures | <https://github.com/PeculiarVentures/pvtsutils#readme> |
| `@peculiar/webcrypto` | 1.7.1 | PeculiarVentures | <https://github.com/PeculiarVentures/webcrypto#readme> |
| `@pkgjs/parseargs` | 0.11.0 |  | <https://github.com/pkgjs/parseargs#readme> |
| `@rolldown/pluginutils` | 1.0.0-beta.27 |  | <https://github.com/rolldown/rolldown#readme> |
| `@rollup/rollup-win32-x64-gnu` | 4.62.4 | Lukas Taegert-Atkinson | <https://rollupjs.org/> |
| `@rollup/rollup-win32-x64-msvc` | 4.62.4 | Lukas Taegert-Atkinson | <https://rollupjs.org/> |
| `@secretlint/config-creator` | 13.0.5 | azu | <https://github.com/secretlint/secretlint/tree/master/packages/@secretlint/config-creator/> |
| `@secretlint/config-loader` | 13.0.5 | azu | <https://github.com/secretlint/secretlint/tree/master/packages/@secretlint/config-loader/> |
| `@secretlint/core` | 13.0.5 | azu | <https://github.com/secretlint/secretlint/tree/master/packages/@secretlint/core/> |
| `@secretlint/formatter` | 13.0.5 | azu | <https://github.com/secretlint/secretlint/tree/master/packages/@secretlint/formatter/> |
| `@secretlint/node` | 13.0.5 | azu | <https://github.com/secretlint/secretlint/tree/master/packages/@secretlint/node/> |
| `@secretlint/profiler` | 13.0.5 | azu | <https://github.com/secretlint/secretlint/tree/master/packages/@secretlint/profiler/> |
| `@secretlint/resolver` | 13.0.5 | azu | <https://github.com/secretlint/secretlint/tree/master/packages/@secretlint/resolver/> |
| `@secretlint/secretlint-rule-preset-recommend` | 13.0.5 | azu | <https://github.com/secretlint/secretlint/tree/master/packages/@secretlint/secretlint-rule-preset-recommend/> |
| `@secretlint/source-creator` | 13.0.5 | azu | <https://github.com/secretlint/secretlint/tree/master/packages/@secretlint/source-creator/> |
| `@secretlint/types` | 13.0.5 | azu | <https://github.com/secretlint/secretlint/tree/master/packages/@secretlint/types/> |
| `@secretlint/walker` | 13.0.5 | azu | <https://github.com/secretlint/secretlint/tree/master/packages/@secretlint/walker/> |
| `@sindresorhus/is` | 4.6.0 | Sindre Sorhus | <https://github.com/sindresorhus/is#readme> |
| `@szmarczak/http-timer` | 4.0.6 | Szymon Marczak | <https://github.com/szmarczak/http-timer#readme> |
| `@testing-library/dom` | 10.4.2 | Kent C. Dodds | <https://github.com/testing-library/dom-testing-library#readme> |
| `@testing-library/jest-dom` | 7.0.1 | Ernesto Garcia | <https://github.com/testing-library/jest-dom#readme> |
| `@testing-library/react` | 16.3.3 | Kent C. Dodds | <https://github.com/testing-library/react-testing-library#readme> |
| `@testing-library/user-event` | 14.6.7 | Giorgio Polvara | <https://github.com/testing-library/user-event#readme> |
| `@textlint/ast-node-types` | 15.8.0 | azu | <https://github.com/textlint/textlint#readme> |
| `@textlint/linter-formatter` | 15.8.0 | azu | <https://github.com/textlint/textlint/tree/master/packages/@textlint/linter-formatter> |
| `@textlint/module-interop` | 15.8.0 | azu | <https://github.com/textlint/textlint/tree/master/packages/@textlint/module-interop/> |
| `@textlint/resolver` | 15.8.0 | azu | <https://github.com/textlint/textlint/tree/master/packages/@textlint/resolver/> |
| `@textlint/types` | 15.8.0 | azu | <https://github.com/textlint/textlint/tree/master/packages/@textlint/types/> |
| `@tweenjs/tween.js` | 23.1.3 | tween.js contributors | <https://github.com/tweenjs/tween.js> |
| `@types/adm-zip` | 0.5.8 |  | <https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/adm-zip> |
| `@types/aria-query` | 5.0.4 |  | <https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/aria-query> |
| `@types/babel__core` | 7.20.5 |  | <https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/babel__core> |
| `@types/babel__generator` | 7.27.0 |  | <https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/babel__generator> |
| `@types/babel__template` | 7.4.4 |  | <https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/babel__template> |
| `@types/babel__traverse` | 7.28.0 |  | <https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/babel__traverse> |
| `@types/cacheable-request` | 6.0.3 |  | <https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/cacheable-request> |
| `@types/chai` | 5.2.3 |  | <https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/chai> |
| `@types/debug` | 4.1.13 |  | <https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/debug> |
| `@types/deep-eql` | 4.0.2 |  | <https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/deep-eql> |
| `@types/esrecurse` | 4.3.1 |  | <https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/esrecurse> |
| `@types/estree` | 1.0.9 |  | <https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/estree> |
| `@types/fs-extra` | 9.0.13 |  | <https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/fs-extra> |
| `@types/http-cache-semantics` | 4.2.0 |  | <https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/http-cache-semantics> |
| `@types/json-schema` | 7.0.15 |  | <https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/json-schema> |
| `@types/keyv` | 3.1.4 |  | <https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/keyv> |
| `@types/ms` | 2.1.0 |  | <https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/ms> |
| `@types/node` | 22.20.1 |  | <https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/node> |
| `@types/normalize-package-data` | 2.4.4 |  | <https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/normalize-package-data> |
| `@types/prop-types` | 15.7.15 |  | <https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/prop-types> |
| `@types/react` | 18.3.31 |  | <https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/react> |
| `@types/react-dom` | 18.3.7 |  | <https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/react-dom> |
| `@types/responselike` | 1.0.3 |  | <https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/responselike> |
| `@types/stats.js` | 0.17.4 |  | <https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/stats.js> |
| `@types/three` | 0.185.4 |  | <https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/three> |
| `@types/webxr` | 0.5.24 |  | <https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/webxr> |
| `@types/ws` | 8.18.1 |  | <https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/ws> |
| `@types/yauzl` | 2.10.3 |  | <https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/yauzl> |
| `@typescript-eslint/eslint-plugin` | 8.70.0 |  | <https://typescript-eslint.io/packages/eslint-plugin> |
| `@typescript-eslint/parser` | 8.70.0 |  | <https://typescript-eslint.io/packages/parser> |
| `@typescript-eslint/project-service` | 8.70.0 |  | <https://typescript-eslint.io> |
| `@typescript-eslint/scope-manager` | 8.70.0 |  | <https://typescript-eslint.io/packages/scope-manager> |
| `@typescript-eslint/tsconfig-utils` | 8.70.0 |  | <https://typescript-eslint.io> |
| `@typescript-eslint/type-utils` | 8.70.0 |  | <https://typescript-eslint.io> |
| `@typescript-eslint/types` | 8.70.0 |  | <https://typescript-eslint.io> |
| `@typescript-eslint/typescript-estree` | 8.70.0 |  | <https://typescript-eslint.io/packages/typescript-estree> |
| `@typescript-eslint/utils` | 8.70.0 |  | <https://typescript-eslint.io/packages/utils> |
| `@typescript-eslint/visitor-keys` | 8.70.0 |  | <https://typescript-eslint.io> |
| `@vitejs/plugin-react` | 4.7.0 | Evan You | <https://github.com/vitejs/vite-plugin-react/tree/main/packages/plugin-react#readme> |
| `@vitest/coverage-v8` | 3.2.7 | Anthony Fu | <https://github.com/vitest-dev/vitest/tree/main/packages/coverage-v8#readme> |
| `@vitest/expect` | 3.2.7 |  | <https://github.com/vitest-dev/vitest/tree/main/packages/expect#readme> |
| `@vitest/mocker` | 3.2.7 |  | <https://github.com/vitest-dev/vitest/tree/main/packages/mocker#readme> |
| `@vitest/pretty-format` | 3.2.7 |  | <https://github.com/vitest-dev/vitest/tree/main/packages/utils#readme> |
| `@vitest/runner` | 3.2.7 |  | <https://github.com/vitest-dev/vitest/tree/main/packages/runner#readme> |
| `@vitest/snapshot` | 3.2.7 |  | <https://github.com/vitest-dev/vitest/tree/main/packages/snapshot#readme> |
| `@vitest/spy` | 3.2.7 |  | <https://github.com/vitest-dev/vitest/tree/main/packages/spy#readme> |
| `@vitest/utils` | 3.2.7 |  | <https://github.com/vitest-dev/vitest/tree/main/packages/utils#readme> |
| `@xmldom/xmldom` | 0.8.15 |  | <https://github.com/xmldom/xmldom> |
| `acorn` | 8.18.0 |  | <https://github.com/acornjs/acorn> |
| `acorn-jsx` | 5.3.2 |  | <https://github.com/acornjs/acorn-jsx> |
| `adm-zip` | 0.6.0 | Nasca Iacob | <https://github.com/cthackers/adm-zip> |
| `agent-base` | 7.1.4 | Nathan Rajlich | <https://github.com/TooTallNate/proxy-agents#readme> |
| `ajv` | 6.15.0, 8.20.0 | Evgeny Poberezkin | <https://ajv.js.org> |
| `ansi-escapes` | 7.3.0 | Sindre Sorhus | <https://github.com/sindresorhus/ansi-escapes#readme> |
| `ansi-regex` | 5.0.1, 6.3.0 | Sindre Sorhus | <https://github.com/chalk/ansi-regex#readme> |
| `ansi-styles` | 4.3.0, 5.2.0, 6.2.3 | Sindre Sorhus | <https://github.com/chalk/ansi-styles#readme> |
| `app-builder-lib` | 26.15.3 | Vladimir Krivosheev | <https://github.com/electron-userland/electron-builder> |
| `argparse` | 1.0.10 |  | <https://github.com/nodeca/argparse#readme> |
| `assertion-error` | 2.0.1 | Jake Luer | <https://github.com/chaijs/assertion-error#readme> |
| `ast-v8-to-istanbul` | 0.3.12 | Ari Perkkiö | <https://github.com/AriPerkkio/ast-v8-to-istanbul> |
| `astral-regex` | 2.0.0 | Kevin Mårtensson | <https://github.com/kevva/astral-regex#readme> |
| `async` | 3.2.6 | Caolan McMahon | <https://caolan.github.io/async/> |
| `async-exit-hook` | 2.0.1 | Tapani Moilanen | <https://github.com/tapppi/async-exit-hook#readme> |
| `asynckit` | 0.4.0 | Alex Indigo | <https://github.com/alexindigo/asynckit#readme> |
| `aws4` | 1.13.2 | Michael Hart | <https://github.com/mhart/aws4#readme> |
| `balanced-match` | 1.0.2, 4.0.4 |  | <https://github.com/juliangruber/balanced-match#readme> |
| `base64-js` | 1.5.1 | T. Jameson Little | <https://github.com/beatgammit/base64-js> |
| `bidi-js` | 1.1.0 | Jason Johnston | <https://github.com/lojjic/bidi-js#readme> |
| `bluebird` | 3.4.7, 3.7.2 | Petka Antonov | <https://github.com/petkaantonov/bluebird> |
| `boolean` | 3.2.0 |  | <https://github.com/thenativeweb/boolean#readme> |
| `brace-expansion` | 1.1.21, 2.1.7, 5.0.12 |  | <https://github.com/juliangruber/brace-expansion#readme> |
| `browserslist` | 4.28.8 | Andrey Sitnik | <https://github.com/browserslist/browserslist#readme> |
| `buffer-crc32` | 0.2.13 | Brian J. Brennan | <https://github.com/brianloveswords/buffer-crc32> |
| `buffer-from` | 1.1.2 |  | <https://github.com/LinusU/buffer-from#readme> |
| `builder-util` | 26.15.3 | Vladimir Krivosheev | <https://github.com/electron-userland/electron-builder> |
| `builder-util-runtime` | 9.7.0 | Vladimir Krivosheev | <https://github.com/electron-userland/electron-builder> |
| `cac` | 6.7.14 | egoist | <https://github.com/egoist/cac#readme> |
| `cacheable` | 2.5.0 | Jared Wray | <https://github.com/jaredwray/cacheable#readme> |
| `cacheable-lookup` | 5.0.4 | Szymon Marczak | <https://github.com/szmarczak/cacheable-lookup#readme> |
| `cacheable-request` | 7.0.4 | Luke Childs | <https://github.com/lukechilds/cacheable-request#readme> |
| `call-bind-apply-helpers` | 1.0.2 | Jordan Harband | <https://github.com/ljharb/call-bind-apply-helpers#readme> |
| `chai` | 5.3.3 | Jake Luer | <http://chaijs.com> |
| `chalk` | 4.1.2, 5.6.2 |  | <https://github.com/chalk/chalk#readme> |
| `check-error` | 2.1.3 | Jake Luer | <https://github.com/chaijs/check-error#readme> |
| `chromium-pickle-js` | 0.2.0 |  | <https://github.com/electron/node-chromium-pickle-js#readme> |
| `ci-info` | 4.3.1, 4.4.0 | Thomas Watson Steen | <https://github.com/watson/ci-info> |
| `clone-response` | 1.0.3 | Luke Childs | <https://github.com/sindresorhus/clone-response#readme> |
| `color-convert` | 2.0.1 | Heather Arthur | <https://github.com/Qix-/color-convert#readme> |
| `color-name` | 1.1.4 | DY | <https://github.com/colorjs/color-name> |
| `combined-stream` | 1.0.8 | Felix Geisendörfer | <https://github.com/felixge/node-combined-stream> |
| `commander` | 5.1.0, 9.5.0 | TJ Holowaychuk | <https://github.com/tj/commander.js#readme> |
| `compare-version` | 0.1.2 | Kevin Mårtensson | <https://github.com/kevva/compare-version#readme> |
| `concat-map` | 0.0.1 | James Halliday | <https://github.com/substack/node-concat-map#readme> |
| `convert-source-map` | 2.0.0 | Thorsten Lorenz | <https://github.com/thlorenz/convert-source-map> |
| `core-util-is` | 1.0.3 | Isaac Z. Schlueter | <https://github.com/isaacs/core-util-is#readme> |
| `cross-dirname` | 0.1.0 |  | <https://github.com/JumpLink/cross-dirname#readme> |
| `cross-spawn` | 7.0.6 | André Cruz | <https://github.com/moxystudio/node-cross-spawn> |
| `css-tree` | 3.2.1 | Roman Dvornov | <https://github.com/csstree/csstree#readme> |
| `css.escape` | 1.5.1 | Mathias Bynens | <https://mths.be/cssescape> |
| `csstype` | 3.2.3 | Fredrik Nicol | <https://github.com/frenic/csstype#readme> |
| `data-urls` | 7.0.0 | Domenic Denicola | <https://github.com/jsdom/data-urls#readme> |
| `debug` | 4.4.3 | Josh Junon | <https://github.com/debug-js/debug#readme> |
| `decimal.js` | 10.6.0 | Michael Mclaughlin | <https://github.com/MikeMcl/decimal.js#readme> |
| `decompress-response` | 6.0.0 | Sindre Sorhus | <https://github.com/sindresorhus/decompress-response#readme> |
| `deep-eql` | 5.0.2 | Jake Luer | <https://github.com/chaijs/deep-eql#readme> |
| `deep-is` | 0.1.4 | Thorsten Lorenz | <https://github.com/thlorenz/deep-is#readme> |
| `defer-to-connect` | 2.0.1 | Szymon Marczak | <https://github.com/szmarczak/defer-to-connect#readme> |
| `define-data-property` | 1.1.4 | Jordan Harband | <https://github.com/ljharb/define-data-property#readme> |
| `define-properties` | 1.2.1 | Jordan Harband | <https://github.com/ljharb/define-properties#readme> |
| `delayed-stream` | 1.0.0 | Felix Geisendörfer | <https://github.com/felixge/node-delayed-stream> |
| `dequal` | 2.0.3 | Luke Edwards | <https://github.com/lukeed/dequal#readme> |
| `detect-node` | 2.1.0 | Ilya Kantor | <https://github.com/iliakan/detect-node> |
| `dir-compare` | 4.2.0 | Liviu Grigorescu | <https://github.com/gliviu/dir-compare#readme> |
| `dmg-builder` | 26.15.3 | Vladimir Krivosheev | <https://github.com/electron-userland/electron-builder> |
| `dom-accessibility-api` | 0.5.16, 0.6.3 |  | <https://github.com/eps1lon/dom-accessibility-api#readme> |
| `dunder-proto` | 1.0.1 | Jordan Harband | <https://github.com/es-shims/dunder-proto#readme> |
| `eastasianwidth` | 0.2.0 | Masaki Komagata | <https://github.com/komagata/eastasianwidth#readme> |
| `electron` | 37.10.3 | Electron Community | <https://github.com/electron/electron#readme> |
| `electron-builder` | 26.15.3 | Vladimir Krivosheev | <https://github.com/electron-userland/electron-builder> |
| `electron-builder-squirrel-windows` | 26.15.3 | Vladimir Krivosheev | <https://github.com/electron-userland/electron-builder> |
| `electron-publish` | 26.15.3 | Vladimir Krivosheev | <https://github.com/electron-userland/electron-builder> |
| `electron-winstaller` | 5.4.0 |  | <https://github.com/electron/windows-installer#readme> |
| `emoji-regex` | 8.0.0, 9.2.2 | Mathias Bynens | <https://mths.be/emoji-regex> |
| `end-of-stream` | 1.4.5 | Mathias Buus | <https://github.com/mafintosh/end-of-stream> |
| `env-paths` | 2.2.1 | Sindre Sorhus | <https://github.com/sindresorhus/env-paths#readme> |
| `environment` | 1.1.0 | Sindre Sorhus | <https://github.com/sindresorhus/environment#readme> |
| `err-code` | 2.0.3 | IndigoUnited | <https://github.com/IndigoUnited/js-err-code#readme> |
| `es-define-property` | 1.0.1 | Jordan Harband | <https://github.com/ljharb/es-define-property#readme> |
| `es-errors` | 1.3.0 | Jordan Harband | <https://github.com/ljharb/es-errors#readme> |
| `es-module-lexer` | 1.7.0 | Guy Bedford | <https://github.com/guybedford/es-module-lexer#readme> |
| `es-object-atoms` | 1.1.2 | Jordan Harband | <https://github.com/ljharb/es-object-atoms#readme> |
| `es-set-tostringtag` | 2.1.0 | Jordan Harband | <https://github.com/es-shims/es-set-tostringtag#readme> |
| `es6-error` | 4.1.1 | Ben Youngblood | <https://github.com/bjyoungblood/es6-error> |
| `esbuild` | 0.25.12, 0.28.2 |  | <https://github.com/evanw/esbuild#readme> |
| `escalade` | 3.2.0 | Luke Edwards | <https://github.com/lukeed/escalade#readme> |
| `escape-string-regexp` | 4.0.0 | Sindre Sorhus | <https://github.com/sindresorhus/escape-string-regexp#readme> |
| `eslint` | 10.10.0 | Nicholas C. Zakas | <https://eslint.org> |
| `eslint-plugin-react-hooks` | 7.1.1 |  | <https://react.dev/> |
| `estree-walker` | 3.0.3 | Rich Harris | <https://github.com/Rich-Harris/estree-walker#readme> |
| `fast-deep-equal` | 3.1.3 | Evgeny Poberezkin | <https://github.com/epoberezkin/fast-deep-equal#readme> |
| `fast-json-stable-stringify` | 2.1.0 | James Halliday | <https://github.com/epoberezkin/fast-json-stable-stringify> |
| `fast-levenshtein` | 2.0.6 | Ramesh Nair | <https://github.com/hiddentao/fast-levenshtein#readme> |
| `fd-slicer` | 1.1.0 | Andrew Kelley | <https://github.com/andrewrk/node-fd-slicer#readme> |
| `fdir` | 6.5.0 | thecodrr | <https://github.com/thecodrr/fdir#readme> |
| `fflate` | 0.8.3 | Arjun Barrett | <https://101arrowz.github.io/fflate> |
| `file-entry-cache` | 11.1.5 | Jared Wray | <https://github.com/jaredwray/cacheable#readme> |
| `find-up` | 5.0.0 | Sindre Sorhus | <https://github.com/sindresorhus/find-up#readme> |
| `flat-cache` | 6.1.23 | Jared Wray | <https://github.com/jaredwray/cacheable#readme> |
| `form-data` | 4.0.6 | Felix Geisendörfer | <https://github.com/form-data/form-data#readme> |
| `fs-extra` | 7.0.1, 8.1.0, 9.1.0, 10.1.0, 11.3.1, 11.4.0 | JP Richardson | <https://github.com/jprichardson/node-fs-extra> |
| `function-bind` | 1.1.2 | Raynos | <https://github.com/Raynos/function-bind> |
| `gensync` | 1.0.0-beta.2 | Logan Smyth | <https://github.com/loganfsmyth/gensync> |
| `get-intrinsic` | 1.3.0 | Jordan Harband | <https://github.com/ljharb/get-intrinsic#readme> |
| `get-proto` | 1.0.1 | Jordan Harband | <https://github.com/ljharb/get-proto#readme> |
| `get-stream` | 5.2.0 | Sindre Sorhus | <https://github.com/sindresorhus/get-stream#readme> |
| `globals` | 17.12.0 | Sindre Sorhus | <https://github.com/sindresorhus/globals#readme> |
| `globalthis` | 1.0.4 | Jordan Harband | <https://github.com/ljharb/System.global#readme> |
| `gopd` | 1.2.0 | Jordan Harband | <https://github.com/ljharb/gopd#readme> |
| `got` | 11.8.6 |  | <https://github.com/sindresorhus/got#readme> |
| `has-flag` | 4.0.0, 5.0.1 | Sindre Sorhus | <https://github.com/sindresorhus/has-flag#readme> |
| `has-property-descriptors` | 1.0.2 | Jordan Harband | <https://github.com/inspect-js/has-property-descriptors#readme> |
| `has-symbols` | 1.1.0 | Jordan Harband | <https://github.com/ljharb/has-symbols#readme> |
| `has-tostringtag` | 1.0.2 | Jordan Harband | <https://github.com/inspect-js/has-tostringtag#readme> |
| `hashery` | 1.5.1 | Jared Wray | <https://github.com/jaredwray/hashery#readme> |
| `hasown` | 2.0.4 | Jordan Harband | <https://github.com/inspect-js/hasOwn#readme> |
| `hermes-estree` | 0.25.1 |  | <https://github.com/facebook/hermes#readme> |
| `hermes-parser` | 0.25.1 |  | <https://github.com/facebook/hermes#readme> |
| `hookified` | 1.15.1, 2.2.0 | Jared Wray | <https://github.com/jaredwray/hookified#readme> |
| `html-encoding-sniffer` | 6.0.0 | Domenic Denicola | <https://github.com/jsdom/html-encoding-sniffer#readme> |
| `html-escaper` | 2.0.2 | Andrea Giammarchi | <https://github.com/WebReflection/html-escaper> |
| `http-proxy-agent` | 7.0.2 | Nathan Rajlich | <https://github.com/TooTallNate/proxy-agents#readme> |
| `http2-wrapper` | 1.0.3 | Szymon Marczak | <https://github.com/szmarczak/http2-wrapper#readme> |
| `https-proxy-agent` | 7.0.6 | Nathan Rajlich | <https://github.com/TooTallNate/proxy-agents#readme> |
| `ignore` | 5.3.2, 7.0.9 | kael | <https://github.com/kaelzhang/node-ignore#readme> |
| `immediate` | 3.0.6 |  | <https://github.com/calvinmetcalf/immediate#readme> |
| `imurmurhash` | 0.1.4 | Jens Taylor | <https://github.com/jensyt/imurmurhash-js> |
| `indent-string` | 4.0.0 | Sindre Sorhus | <https://github.com/sindresorhus/indent-string#readme> |
| `index-to-position` | 1.2.0 | Sindre Sorhus | <https://github.com/sindresorhus/index-to-position#readme> |
| `is-extglob` | 2.1.1 | Jon Schlinkert | <https://github.com/jonschlinkert/is-extglob> |
| `is-fullwidth-code-point` | 3.0.0 | Sindre Sorhus | <https://github.com/sindresorhus/is-fullwidth-code-point#readme> |
| `is-glob` | 4.0.3 | Jon Schlinkert | <https://github.com/micromatch/is-glob> |
| `is-potential-custom-element-name` | 1.0.1 | Mathias Bynens | <https://github.com/mathiasbynens/is-potential-custom-element-name> |
| `isarray` | 1.0.0 | Julian Gruber | <https://github.com/juliangruber/isarray> |
| `isbinaryfile` | 4.0.10, 5.0.7 |  | <https://github.com/gjtorikian/isBinaryFile#readme> |
| `jiti` | 2.7.0 |  | <https://github.com/unjs/jiti#readme> |
| `js-tokens` | 4.0.0, 9.0.1, 10.0.0 | Simon Lydell | <https://github.com/lydell/js-tokens#readme> |
| `js-yaml` | 4.3.2 | Vladimir Zapparov | <https://github.com/nodeca/js-yaml#readme> |
| `jsdom` | 30.0.1 |  | <https://github.com/jsdom/jsdom#readme> |
| `jsesc` | 3.1.0 | Mathias Bynens | <https://mths.be/jsesc> |
| `json-buffer` | 3.0.1 | Dominic Tarr | <https://github.com/dominictarr/json-buffer> |
| `json-schema-traverse` | 0.4.1, 1.0.0 | Evgeny Poberezkin | <https://github.com/epoberezkin/json-schema-traverse#readme> |
| `json-stable-stringify-without-jsonify` | 1.0.1 | James Halliday | <https://github.com/samn/json-stable-stringify> |
| `json5` | 2.2.3 | Aseem Kishore | <http://json5.org/> |
| `jsonfile` | 4.0.0, 6.2.1 | JP Richardson | <https://github.com/jprichardson/node-jsonfile#readme> |
| `keyv` | 4.5.4, 5.6.0 | Jared Wray | <https://github.com/jaredwray/keyv> |
| `lazy-val` | 1.0.5 | Vladimir Krivosheev | <https://github.com/develar/lazy-val> |
| `levn` | 0.4.1 | George Zahariev | <https://github.com/gkz/levn> |
| `lie` | 3.3.0 |  | <https://github.com/calvinmetcalf/lie#readme> |
| `locate-path` | 6.0.0 | Sindre Sorhus | <https://github.com/sindresorhus/locate-path#readme> |
| `lodash` | 4.18.1 | John-David Dalton | <https://lodash.com/> |
| `lodash.truncate` | 4.4.2 | John-David Dalton | <https://lodash.com/> |
| `loose-envify` | 1.4.0 | Andres Suarez | <https://github.com/zertosh/loose-envify> |
| `loupe` | 3.2.1 | Veselin Todorov | <https://github.com/chaijs/loupe> |
| `lowercase-keys` | 2.0.0 | Sindre Sorhus | <https://github.com/sindresorhus/lowercase-keys#readme> |
| `lz-string` | 1.5.0 | pieroxy | <http://pieroxy.net/blog/pages/lz-string/index.html> |
| `magic-string` | 0.30.21 | Rich Harris | <https://github.com/Rich-Harris/magic-string#readme> |
| `magicast` | 0.3.5 |  | <https://github.com/unjs/magicast#readme> |
| `make-dir` | 4.0.0 | Sindre Sorhus | <https://github.com/sindresorhus/make-dir#readme> |
| `matcher` | 3.0.0 | Sindre Sorhus | <https://github.com/sindresorhus/matcher#readme> |
| `math-intrinsics` | 1.1.0 | Jordan Harband | <https://github.com/es-shims/math-intrinsics#readme> |
| `meshoptimizer` | 1.1.1 | Arseny Kapoulkine | <https://github.com/zeux/meshoptimizer> |
| `mime` | 2.6.0 | Robert Kieffer | <https://github.com/broofa/mime#readme> |
| `mime-db` | 1.52.0 |  | <https://github.com/jshttp/mime-db#readme> |
| `mime-types` | 2.1.35 |  | <https://github.com/jshttp/mime-types#readme> |
| `mimic-response` | 1.0.1, 3.1.0 | Sindre Sorhus | <https://github.com/sindresorhus/mimic-response#readme> |
| `min-indent` | 1.0.1 | James Kyle | <https://github.com/thejameskyle/min-indent#readme> |
| `minimist` | 1.2.8 | James Halliday | <https://github.com/minimistjs/minimist> |
| `minizlib` | 3.1.0 | Isaac Z. Schlueter | <https://github.com/isaacs/minizlib#readme> |
| `mkdirp` | 0.5.6 | James Halliday | <https://github.com/substack/node-mkdirp#readme> |
| `ms` | 2.1.3 |  | <https://github.com/vercel/ms#readme> |
| `nanoid` | 3.3.18 | Andrey Sitnik | <https://github.com/ai/nanoid#readme> |
| `natural-compare` | 1.4.0 | Lauri Rooden | <https://github.com/litejs/natural-compare-lite#readme> |
| `node-abi` | 4.35.0 | Lukas Geiger | <https://github.com/electron/node-abi#readme> |
| `node-api-version` | 0.2.1 | Tim Fish | <https://github.com/timfish/node-api-version#readme> |
| `node-gyp` | 12.4.0 | Nathan Rajlich | <https://github.com/nodejs/node-gyp#readme> |
| `node-int64` | 0.4.0 | Robert Kieffer | <https://github.com/broofa/node-int64#readme> |
| `node-releases` | 2.0.53 | Sergey Rubanov | <https://github.com/chicoxyzzy/node-releases#readme> |
| `normalize-url` | 6.1.0 | Sindre Sorhus | <https://github.com/sindresorhus/normalize-url#readme> |
| `object-keys` | 1.1.1 | Jordan Harband | <https://github.com/ljharb/object-keys#readme> |
| `optionator` | 0.9.4 | George Zahariev | <https://github.com/gkz/optionator> |
| `p-cancelable` | 2.1.1 | Sindre Sorhus | <https://github.com/sindresorhus/p-cancelable#readme> |
| `p-limit` | 3.1.0 | Sindre Sorhus | <https://github.com/sindresorhus/p-limit#readme> |
| `p-locate` | 5.0.0 | Sindre Sorhus | <https://github.com/sindresorhus/p-locate#readme> |
| `p-map` | 7.0.8 | Sindre Sorhus | <https://github.com/sindresorhus/p-map#readme> |
| `parse-json` | 8.3.0 | Sindre Sorhus | <https://github.com/sindresorhus/parse-json#readme> |
| `parse5` | 8.0.1 | Ivan Nikulin | <https://parse5.js.org> |
| `path-exists` | 4.0.0 | Sindre Sorhus | <https://github.com/sindresorhus/path-exists#readme> |
| `path-is-absolute` | 1.0.1 | Sindre Sorhus | <https://github.com/sindresorhus/path-is-absolute#readme> |
| `path-key` | 3.1.1 | Sindre Sorhus | <https://github.com/sindresorhus/path-key#readme> |
| `pathe` | 2.0.3 |  | <https://github.com/unjs/pathe#readme> |
| `pathval` | 2.0.1 | Veselin Todorov | <https://github.com/chaijs/pathval> |
| `pe-library` | 0.4.1 | jet | <https://github.com/jet2jet/pe-library-js> |
| `pend` | 1.2.0 | Andrew Kelley | <https://github.com/andrewrk/node-pend#readme> |
| `picomatch` | 4.0.5 | Jon Schlinkert | <https://github.com/micromatch/picomatch> |
| `plist` | 3.1.0 | Nathan Rajlich | <https://github.com/TooTallNate/node-plist#readme> |
| `pluralize` | 2.0.0, 8.0.0 | Blake Embrey | <https://github.com/blakeembrey/pluralize#readme> |
| `postcss` | 8.5.26 | Andrey Sitnik | <https://postcss.org/> |
| `postject` | 1.0.0-alpha.6 |  | <https://github.com/nodejs/postject#readme> |
| `pptx-wasm` | 0.3.0 | Prabhanu | <https://github.com/prahack/pptx-wasm#readme> |
| `prelude-ls` | 1.2.1 | George Zahariev | <http://preludels.com> |
| `pretty-format` | 27.5.1 | James Kyle | <https://github.com/facebook/jest#readme> |
| `process-nextick-args` | 2.0.1 |  | <https://github.com/calvinmetcalf/process-nextick-args> |
| `progress` | 2.0.3 | TJ Holowaychuk | <https://github.com/visionmedia/node-progress#readme> |
| `promise-retry` | 2.0.1 | IndigoUnited | <https://github.com/IndigoUnited/node-promise-retry#readme> |
| `proper-lockfile` | 4.1.2 | André Cruz | <https://github.com/moxystudio/node-proper-lockfile> |
| `pump` | 3.0.4 | Mathias Buus Madsen | <https://github.com/mafintosh/pump#readme> |
| `punycode` | 2.3.1 | Mathias Bynens | <https://mths.be/punycode> |
| `pvtsutils` | 1.3.6 | PeculiarVentures | <https://github.com/PeculiarVentures/pvtsutils#readme> |
| `pvutils` | 1.2.0 | Yury Strozhevsky | <https://github.com/PeculiarVentures/pvutils#readme> |
| `qified` | 0.10.1 | Jared Wray | <https://github.com/jaredwray/qified#readme> |
| `quick-lru` | 5.1.1 | Sindre Sorhus | <https://github.com/sindresorhus/quick-lru#readme> |
| `rc-config-loader` | 4.1.4 | azu | <https://github.com/azu/rc-config-loader> |
| `react` | 18.3.1 |  | <https://reactjs.org/> |
| `react-dom` | 18.3.1 |  | <https://reactjs.org/> |
| `react-is` | 17.0.2 |  | <https://reactjs.org/> |
| `react-refresh` | 0.17.0 |  | <https://react.dev/> |
| `read-binary-file-arch` | 1.0.6 | Samuel Maddock | <https://github.com/samuelmaddock/read-binary-file-arch#readme> |
| `read-pkg` | 10.1.0 | Sindre Sorhus | <https://github.com/sindresorhus/read-pkg#readme> |
| `readable-stream` | 2.3.8 |  | <https://github.com/nodejs/readable-stream#readme> |
| `redent` | 3.0.0 | Sindre Sorhus | <https://github.com/sindresorhus/redent#readme> |
| `require-directory` | 2.1.1 | Troy Goode | <https://github.com/troygoode/node-require-directory/> |
| `require-from-string` | 2.0.2 | Vsevolod Strukchinsky | <https://github.com/floatdrop/require-from-string#readme> |
| `resedit` | 1.7.2 | jet | <https://github.com/jet2jet/resedit-js> |
| `resolve-alpn` | 1.2.1 | Szymon Marczak | <https://github.com/szmarczak/resolve-alpn#readme> |
| `responselike` | 2.0.1 | lukechilds | <https://github.com/sindresorhus/responselike#readme> |
| `retry` | 0.12.0 | Tim Koschützki | <https://github.com/tim-kos/node-retry> |
| `rollup` | 4.62.4 | Rich Harris | <https://rollupjs.org/> |
| `safe-buffer` | 5.1.2 | Feross Aboukhadijeh | <https://github.com/feross/safe-buffer> |
| `scheduler` | 0.23.2 |  | <https://reactjs.org/> |
| `secretlint` | 13.0.5 | azu | <https://github.com/secretlint/secretlint/tree/master/packages/secretlint/> |
| `semver-compare` | 1.0.0 | James Halliday | <https://github.com/substack/semver-compare> |
| `serialize-error` | 7.0.1 | Sindre Sorhus | <https://github.com/sindresorhus/serialize-error#readme> |
| `setimmediate` | 1.0.5 | YuzuJS | <https://github.com/YuzuJS/setImmediate#readme> |
| `shebang-command` | 2.0.0 | Kevin Mårtensson | <https://github.com/kevva/shebang-command#readme> |
| `shebang-regex` | 3.0.0 | Sindre Sorhus | <https://github.com/sindresorhus/shebang-regex#readme> |
| `simple-update-notifier` | 2.0.0 | alexbrazier | <https://github.com/alexbrazier/simple-update-notifier.git> |
| `slice-ansi` | 4.0.0 |  | <https://github.com/chalk/slice-ansi#readme> |
| `source-map-support` | 0.5.21 |  | <https://github.com/evanw/node-source-map-support#readme> |
| `spdx-expression-parse` | 3.0.1 | Kyle E. Mitchell | <https://github.com/jslicense/spdx-expression-parse.js#readme> |
| `stackback` | 0.0.2 | Roman Shtylman | <https://github.com/shtylman/node-stackback#readme> |
| `stat-mode` | 1.0.0 | Nathan Rajlich | <https://github.com/TooTallNate/stat-mode> |
| `std-env` | 3.10.0 |  | <https://github.com/unjs/std-env#readme> |
| `string_decoder` | 1.1.1 |  | <https://github.com/nodejs/string_decoder> |
| `string-width` | 4.2.3, 5.1.2 | Sindre Sorhus | <https://github.com/sindresorhus/string-width#readme> |
| `strip-ansi` | 6.0.1, 7.2.0 | Sindre Sorhus | <https://github.com/chalk/strip-ansi#readme> |
| `strip-indent` | 3.0.0 | Sindre Sorhus | <https://github.com/sindresorhus/strip-indent#readme> |
| `strip-literal` | 3.1.0 | Anthony Fu | <https://github.com/antfu/strip-literal#readme> |
| `supports-color` | 7.2.0, 10.2.2 | Sindre Sorhus | <https://github.com/chalk/supports-color#readme> |
| `supports-hyperlinks` | 4.5.0 |  | <https://github.com/chalk/supports-hyperlinks#readme> |
| `symbol-tree` | 3.2.4 | Joris van der Wel | <https://github.com/jsdom/js-symbol-tree#symbol-tree> |
| `tagged-tag` | 1.0.0 | Sindre Sorhus | <https://github.com/sindresorhus/tagged-tag#readme> |
| `temp` | 0.9.4 | Bruce Williams | <https://github.com/bruce/node-temp#readme> |
| `temp-file` | 3.4.0 | Vladimir Krivosheev | <https://github.com/develar/temp-file> |
| `terminal-link` | 5.0.0 | Sindre Sorhus | <https://github.com/sindresorhus/terminal-link#readme> |
| `text-table` | 0.2.0 | James Halliday | <https://github.com/substack/text-table> |
| `three` | 0.185.1 | mrdoob | <https://threejs.org/> |
| `tiny-async-pool` | 1.3.0 | Rafael Xavier de Souza | <https://github.com/rxaviers/async-pool#readme> |
| `tinybench` | 2.9.0 |  | <https://github.com/tinylibs/tinybench#readme> |
| `tinyexec` | 0.3.2 | James Garbutt | <https://github.com/tinylibs/tinyexec#readme> |
| `tinyglobby` | 0.2.17 | Superchupu | <https://superchupu.dev/tinyglobby> |
| `tinypool` | 1.1.1 |  | <https://github.com/tinylibs/tinypool#readme> |
| `tinyrainbow` | 2.0.0 |  | <https://github.com/tinylibs/tinyrainbow#readme> |
| `tinyspy` | 4.0.4 |  | <https://github.com/tinylibs/tinyspy#readme> |
| `tldts` | 7.4.13 | Rémi Berson | <https://github.com/remusao/tldts#readme> |
| `tldts-core` | 7.4.13 | Rémi Berson | <https://github.com/remusao/tldts#readme> |
| `tmp` | 0.2.7 | KARASZI István | <http://github.com/raszi/node-tmp> |
| `tmp-promise` | 3.0.3 | Benjamin Gruenbaum and Collaborators. | <https://github.com/benjamingr/tmp-promise#readme> |
| `tr46` | 6.0.0 | Sebastian Mayr | <https://github.com/jsdom/tr46#readme> |
| `ts-api-utils` | 2.5.0 | JoshuaKGoldberg | <https://github.com/JoshuaKGoldberg/ts-api-utils#readme> |
| `type-check` | 0.4.0 | George Zahariev | <https://github.com/gkz/type-check> |
| `typescript-eslint` | 8.70.0 |  | <https://typescript-eslint.io/packages/typescript-eslint> |
| `underscore` | 1.13.8 | Jeremy Ashkenas | <https://underscorejs.org> |
| `undici` | 6.28.1, 8.10.2 |  | <https://undici.nodejs.org> |
| `undici-types` | 6.21.0 |  | <https://undici.nodejs.org> |
| `unicorn-magic` | 0.4.0 | Sindre Sorhus | <https://github.com/sindresorhus/unicorn-magic#readme> |
| `universalify` | 0.1.2, 2.0.1 | Ryan Zimmerman | <https://github.com/RyanZim/universalify#readme> |
| `unzipper` | 0.12.5 | Ziggy Jonsson | <https://github.com/ZJONSSON/node-unzipper#readme> |
| `update-browserslist-db` | 1.3.1 | Andrey Sitnik | <https://github.com/browserslist/update-db#readme> |
| `util-deprecate` | 1.0.2 | Nathan Rajlich | <https://github.com/TooTallNate/util-deprecate> |
| `vite` | 6.4.3, 7.3.6 | Evan You | <https://vite.dev> |
| `vite-node` | 3.2.4 | Anthony Fu | <https://github.com/vitest-dev/vitest/blob/main/packages/vite-node#readme> |
| `vitest` | 3.2.7 | Anthony Fu | <https://github.com/vitest-dev/vitest#readme> |
| `w3c-xmlserializer` | 5.0.0 |  | <https://github.com/jsdom/w3c-xmlserializer#readme> |
| `webcrypto-core` | 1.9.2 | PeculiarVentures | <https://github.com/PeculiarVentures/webcrypto-core#readme> |
| `whatwg-mimetype` | 5.0.0 | Domenic Denicola | <https://github.com/jsdom/whatwg-mimetype#readme> |
| `whatwg-url` | 16.0.1, 17.1.1 | Sebastian Mayr | <https://github.com/jsdom/whatwg-url#readme> |
| `why-is-node-running` | 2.3.0 | Mathias Buus | <https://github.com/mafintosh/why-is-node-running> |
| `word-wrap` | 1.2.5 | Jon Schlinkert | <https://github.com/jonschlinkert/word-wrap> |
| `wrap-ansi` | 7.0.0, 8.1.0 | Sindre Sorhus | <https://github.com/chalk/wrap-ansi#readme> |
| `ws` | 8.21.3 | Einar Otto Stangvik | <https://github.com/websockets/ws> |
| `xmlbuilder` | 10.1.1, 15.1.1 | Ozgur Ozcitak | <http://github.com/oozcitak/xmlbuilder-js> |
| `xmlchars` | 2.2.0 | Louis-Dominique Dubeau | <https://github.com/lddubeau/xmlchars#readme> |
| `yargs` | 17.7.3 |  | <https://yargs.js.org/> |
| `yauzl` | 2.10.0 | Josh Wolfe | <https://github.com/thejoshwolfe/yauzl> |
| `yocto-queue` | 0.1.0 | Sindre Sorhus | <https://github.com/sindresorhus/yocto-queue#readme> |
| `zod` | 4.6.5 | Colin McDonnell | <https://zod.dev> |
| `zod-validation-error` | 4.0.2 | Dimitrios C. Michalakos | <https://github.com/causaly/zod-validation-error#readme> |

### Apache-2.0（38 个，需保留声明）

| 包 | 版本 | 作者 | 仓库 / 主页 |
| --- | --- | --- | --- |
| `@ampproject/remapping` | 2.3.0 | Justin Ridgewell | <https://github.com/ampproject/remapping#readme> |
| `@dimforge/rapier3d-compat` | 0.12.0 |  | <https://rapier.rs> |
| `@eslint/config-array` | 0.23.5 | Nicholas C. Zakas | <https://github.com/eslint/rewrite/tree/main/packages/config-array#readme> |
| `@eslint/config-helpers` | 0.7.0 |  | <https://github.com/eslint/rewrite/tree/main/packages/config-helpers#readme> |
| `@eslint/core` | 1.2.1 | Nicholas C. Zakas | <https://github.com/eslint/rewrite/tree/main/packages/core#readme> |
| `@eslint/object-schema` | 3.0.5 | Nicholas C. Zakas | <https://github.com/eslint/rewrite/tree/main/packages/object-schema#readme> |
| `@eslint/plugin-kit` | 0.7.3 | Nicholas C. Zakas | <https://github.com/eslint/rewrite/tree/main/packages/plugin-kit#readme> |
| `@humanfs/core` | 0.19.2 | Nicholas C. Zakas | <https://github.com/humanwhocodes/humanfs#readme> |
| `@humanfs/node` | 0.16.8 | Nicholas C. Zakas | <https://github.com/humanwhocodes/humanfs#readme> |
| `@humanfs/types` | 0.15.0 | Nicholas C. Zakas | <https://github.com/humanwhocodes/humanfs#readme> |
| `@humanwhocodes/module-importer` | 1.0.1 | Nicholas C. Zaks | <https://github.com/humanwhocodes/module-importer#readme> |
| `@humanwhocodes/retry` | 0.4.3 | Nicholas C. Zaks | <https://github.com/humanwhocodes/retry#readme> |
| `@malept/cross-spawn-promise` | 2.0.0 | Mark Lee | <https://github.com/malept/cross-spawn-promise#readme> |
| `@playwright/test` | 1.63.0 | Microsoft Corporation | <https://playwright.dev> |
| `adler-32` | 1.3.1 | sheetjs | <http://sheetjs.com/opensource> |
| `aria-query` | 5.3.0, 5.3.2 | Jesse Beach | <https://github.com/A11yance/aria-query#readme> |
| `baseline-browser-mapping` | 2.11.15 |  | <https://github.com/web-platform-dx/baseline-browser-mapping#readme> |
| `cfb` | 1.2.2 | sheetjs | <http://sheetjs.com/> |
| `codepage` | 1.15.0 | SheetJS | <https://sheetjs.com/> |
| `crc-32` | 1.2.2 | sheetjs | <https://sheetjs.com/> |
| `ejs` | 3.1.10 | Matthew Eernisse | <https://github.com/mde/ejs> |
| `eslint-visitor-keys` | 3.4.3, 5.0.1 | Toru Nagashima | <https://github.com/eslint/js/blob/main/packages/eslint-visitor-keys/README.md> |
| `expect-type` | 1.4.0 |  | <https://github.com/mmkal/expect-type#readme> |
| `exponential-backoff` | 3.1.3 | Sami Sayegh | <https://github.com/coveooss/exponential-backoff#readme> |
| `filelist` | 1.0.6 | Matthew Eernisse | <https://github.com/mde/filelist> |
| `frac` | 1.1.2 | SheetJS | <http://sheetjs.com/opensource> |
| `jake` | 10.9.4 | Matthew Eernisse | <https://github.com/jakejs/jake#readme> |
| `playwright` | 1.63.0 | Microsoft Corporation | <https://playwright.dev> |
| `playwright-core` | 1.63.0 | Microsoft Corporation | <https://playwright.dev> |
| `spdx-correct` | 3.2.0 |  | <https://github.com/jslicense/spdx-correct.js#readme> |
| `ssf` | 0.11.2 | sheetjs | <http://sheetjs.com/> |
| `sumchecker` | 3.0.1 | Mark Lee | <https://github.com/malept/sumchecker#readme> |
| `typescript` | 5.9.3 | Microsoft Corp. | <https://www.typescriptlang.org/> |
| `validate-npm-package-license` | 3.0.4 | Kyle E. Mitchell | <https://github.com/kemitchell/validate-npm-package-license.js#readme> |
| `wmf` | 1.0.2 | sheetjs | <https://sheetjs.com/> |
| `word` | 0.3.0 | sheetjs | <https://wordjs.com/> |
| `xlsx` | 0.18.5 | sheetjs | <https://sheetjs.com/> |
| `xml-name-validator` | 5.0.0 | Domenic Denicola | <https://github.com/jsdom/xml-name-validator#readme> |

### ISC（36 个，需保留声明）

| 包 | 版本 | 作者 | 仓库 / 主页 |
| --- | --- | --- | --- |
| `@isaacs/cliui` | 8.0.2 | Ben Coe | <https://github.com/yargs/cliui#readme> |
| `@isaacs/fs-minipass` | 4.0.1 | Isaac Z. Schlueter | <https://github.com/npm/fs-minipass#readme> |
| `abbrev` | 4.0.0 | GitHub Inc. | <https://github.com/npm/abbrev-js#readme> |
| `at-least-node` | 1.0.0 | Ryan Zimmerman | <https://github.com/RyanZim/at-least-node#readme> |
| `cliui` | 8.0.1 | Ben Coe | <https://github.com/yargs/cliui#readme> |
| `electron-to-chromium` | 1.5.411 | Kilian Valkhof | <https://github.com/Kilian/electron-to-chromium#readme> |
| `flatted` | 3.4.4 | Andrea Giammarchi | <https://github.com/WebReflection/flatted#readme> |
| `foreground-child` | 3.3.1 | Isaac Z. Schlueter | <https://github.com/tapjs/foreground-child#readme> |
| `fs.realpath` | 1.0.0 | Isaac Z. Schlueter | <https://github.com/isaacs/fs.realpath#readme> |
| `get-caller-file` | 2.0.5 | Stefan Penner | <https://github.com/stefanpenner/get-caller-file#readme> |
| `glob` | 7.2.3, 10.5.0 | Isaac Z. Schlueter | <https://github.com/isaacs/node-glob#readme> |
| `glob-parent` | 6.0.2 | Gulp Team | <https://github.com/gulpjs/glob-parent#readme> |
| `graceful-fs` | 4.2.11 |  | <https://github.com/isaacs/node-graceful-fs#readme> |
| `hosted-git-info` | 4.1.0, 9.0.3 | GitHub Inc. | <https://github.com/npm/hosted-git-info> |
| `inflight` | 1.0.6 | Isaac Z. Schlueter | <https://github.com/isaacs/inflight> |
| `inherits` | 2.0.4 |  | <https://github.com/isaacs/inherits#readme> |
| `isexe` | 2.0.0 | Isaac Z. Schlueter | <https://github.com/isaacs/isexe#readme> |
| `json-stringify-safe` | 5.0.1 | Isaac Z. Schlueter | <https://github.com/isaacs/json-stringify-safe> |
| `lru-cache` | 5.1.1, 6.0.0, 10.4.3 | Isaac Z. Schlueter | <https://github.com/isaacs/node-lru-cache#readme> |
| `minimatch` | 3.1.5, 5.1.9, 9.0.9 | Isaac Z. Schlueter | <https://github.com/isaacs/minimatch#readme> |
| `nopt` | 9.0.0 | GitHub Inc. | <https://github.com/npm/nopt#readme> |
| `once` | 1.4.0 | Isaac Z. Schlueter | <https://github.com/isaacs/once#readme> |
| `picocolors` | 1.1.1 | Alexey Raspopov | <https://github.com/alexeyraspopov/picocolors#readme> |
| `proc-log` | 6.1.0 | GitHub Inc. | <https://github.com/npm/proc-log#readme> |
| `rimraf` | 2.6.3 | Isaac Z. Schlueter | <https://github.com/isaacs/rimraf#readme> |
| `saxes` | 6.0.0 | Louis-Dominique Dubeau | <https://github.com/lddubeau/saxes#readme> |
| `semver` | 5.7.2, 6.3.1, 7.7.4, 7.8.5 | GitHub Inc. | <https://github.com/npm/node-semver#readme> |
| `siginfo` | 2.0.0 | Emil Bay | <https://github.com/emilbayes/siginfo#readme> |
| `signal-exit` | 3.0.7, 4.1.0 | Ben Coe | <https://github.com/tapjs/signal-exit#readme> |
| `test-exclude` | 7.0.2 | Ben Coe | <https://istanbul.js.org/> |
| `which` | 2.0.2, 5.0.0, 6.0.1 | GitHub Inc. | <https://github.com/npm/node-which#readme> |
| `wrappy` | 1.0.2 | Isaac Z. Schlueter | <https://github.com/npm/wrappy> |
| `y18n` | 5.0.8 | Ben Coe | <https://github.com/yargs/y18n> |
| `yallist` | 3.1.1, 4.0.0 | Isaac Z. Schlueter | <https://github.com/isaacs/yallist#readme> |
| `yaml` | 2.9.0 | Eemeli Aro | <https://eemeli.org/yaml/> |
| `yargs-parser` | 21.1.1 | Ben Coe | <https://github.com/yargs/yargs-parser#readme> |

### BSD-2-Clause（21 个，需保留声明）

| 包 | 版本 | 作者 | 仓库 / 主页 |
| --- | --- | --- | --- |
| `@electron/osx-sign` | 1.3.3 | electron | <https://github.com/electron/osx-sign> |
| `@electron/windows-sign` | 1.2.2 | Felix Rieseberg | <https://github.com/electron/windows-sign> |
| `boundary` | 2.0.0 | Yusuke SUZUKI | <https://github.com/textlint/boundary> |
| `dingbat-to-unicode` | 1.0.1 | Michael Williamson | <https://github.com/mwilliamson/dingbat-to-unicode#readme> |
| `dotenv` | 16.6.1 |  | <https://github.com/motdotla/dotenv#readme> |
| `dotenv-expand` | 11.0.7 | motdotla | <https://github.com/motdotla/dotenv-expand#readme> |
| `entities` | 8.1.0 | Felix Boehm | <https://github.com/fb55/entities#readme> |
| `eslint-scope` | 9.1.2 |  | <https://github.com/eslint/js/blob/main/packages/eslint-scope/README.md> |
| `espree` | 11.2.0 | Nicholas C. Zakas | <https://github.com/eslint/js/blob/main/packages/espree/README.md> |
| `esrecurse` | 4.3.0 |  | <https://github.com/estools/esrecurse> |
| `estraverse` | 5.3.0 |  | <https://github.com/estools/estraverse> |
| `esutils` | 2.0.3 |  | <https://github.com/estools/esutils> |
| `extract-zip` | 2.0.1 | max ogden | <https://github.com/maxogden/extract-zip#readme> |
| `http-cache-semantics` | 4.2.0 | Kornel Lesiński | <https://github.com/kornelski/http-cache-semantics#readme> |
| `lop` | 0.4.2 | Michael Williamson | <https://github.com/mwilliamson/lop#readme> |
| `mammoth` | 1.12.1 | Michael Williamson | <https://github.com/mwilliamson/mammoth.js#readme> |
| `normalize-package-data` | 8.0.0 | GitHub Inc. | <https://github.com/npm/normalize-package-data#readme> |
| `option` | 0.2.4 | Michael Williamson | <https://github.com/mwilliamson/node-options#readme> |
| `structured-source` | 4.0.0 | Yusuke SUZUKI | <https://github.com/textlint/structured-source> |
| `uri-js` | 4.4.1 | Gary Court | <https://github.com/garycourt/uri-js> |
| `webidl-conversions` | 8.0.1 | Domenic Denicola | <https://github.com/jsdom/webidl-conversions#readme> |

### BSD-3-Clause（18 个，需保留声明）

| 包 | 版本 | 作者 | 仓库 / 主页 |
| --- | --- | --- | --- |
| `@azu/format-text` | 1.0.2 | azu | <https://github.com/azu/format-text#readme> |
| `asn1js` | 3.0.10 | Yury Strozhevsky | <https://github.com/PeculiarVentures/ASN1.js#readme> |
| `bytestreamjs` | 2.0.1 | Yury Strozhevsky | <https://github.com/PeculiarVentures/ByteStream.js#readme> |
| `duplexer2` | 0.1.4 | Conrad Pankoff | <https://github.com/deoxxa/duplexer2#readme> |
| `esquery` | 1.7.0 | Joel Feenstra | <https://github.com/estools/esquery/> |
| `fast-uri` | 3.1.8 | Vincent Le Goff | <https://github.com/fastify/fast-uri> |
| `global-agent` | 3.0.0 | Gajus Kuizinas | <https://github.com/gajus/global-agent#readme> |
| `istanbul-lib-coverage` | 3.2.2 | Krishnan Anantheswaran | <https://istanbul.js.org/> |
| `istanbul-lib-report` | 3.0.1 | Krishnan Anantheswaran | <https://istanbul.js.org/> |
| `istanbul-lib-source-maps` | 5.0.6 | Krishnan Anantheswaran | <https://istanbul.js.org/> |
| `istanbul-reports` | 3.2.0 | Krishnan Anantheswaran | <https://istanbul.js.org/> |
| `pkijs` | 3.4.0 | Yury Strozhevsky | <https://github.com/PeculiarVentures/PKI.js#readme> |
| `roarr` | 2.15.4 | Gajus Kuizinas | <https://github.com/gajus/roarr#readme> |
| `source-map` | 0.6.1 | Nick Fitzgerald | <https://github.com/mozilla/source-map> |
| `source-map-js` | 1.2.1 | Valentin 7rulnik Semirulnik | <https://github.com/7rulnik/source-map-js> |
| `sprintf-js` | 1.0.3, 1.1.3 | Alexandru Mărășteanu | <https://github.com/alexei/sprintf.js#readme> |
| `table` | 6.9.0 | Gajus Kuizinas | <https://github.com/gajus/table#readme> |
| `tough-cookie` | 6.0.2 | Jeremy Stashewsky | <https://github.com/salesforce/tough-cookie> |

### BlueOak-1.0.0（11 个，需保留声明）

| 包 | 版本 | 作者 | 仓库 / 主页 |
| --- | --- | --- | --- |
| `chownr` | 3.0.0 | Isaac Z. Schlueter | <https://github.com/isaacs/chownr#readme> |
| `isexe` | 3.1.5, 4.0.0 | Isaac Z. Schlueter | <https://github.com/isaacs/isexe#readme> |
| `jackspeak` | 3.4.3 | Isaac Z. Schlueter | <https://github.com/isaacs/jackspeak#readme> |
| `lru-cache` | 11.5.2 | Isaac Z. Schlueter | <https://github.com/isaacs/node-lru-cache#readme> |
| `minimatch` | 10.2.6 | Isaac Z. Schlueter | <https://github.com/isaacs/minimatch#readme> |
| `minipass` | 7.1.3 | Isaac Z. Schlueter | <https://github.com/isaacs/minipass#readme> |
| `package-json-from-dist` | 1.0.1 | Isaac Z. Schlueter | <https://github.com/isaacs/package-json-from-dist#readme> |
| `path-scurry` | 1.11.1 | Isaac Z. Schlueter | <https://github.com/isaacs/path-scurry#readme> |
| `sax` | 1.6.1 | Isaac Z. Schlueter | <https://github.com/isaacs/sax-js#readme> |
| `tar` | 7.5.22 | Isaac Z. Schlueter | <https://github.com/isaacs/node-tar#readme> |
| `yallist` | 5.0.0 | Isaac Z. Schlueter | <https://github.com/isaacs/yallist#readme> |

### BSD（1 个，需保留声明）

| 包 | 版本 | 作者 | 仓库 / 主页 |
| --- | --- | --- | --- |
| `duck` | 0.1.12 | Michael Williamson | <https://github.com/mwilliamson/duck.js#readme> |

### CC0-1.0（2 个，免声明）

| 包 | 版本 | 作者 | 仓库 / 主页 |
| --- | --- | --- | --- |
| `mdn-data` | 2.27.1 | Mozilla Developer Network | <https://developer.mozilla.org> |
| `spdx-license-ids` | 3.0.23 | Shinnosuke Watanabe | <https://github.com/jslicense/spdx-license-ids#readme> |

### MIT-0（2 个，免声明）

| 包 | 版本 | 作者 | 仓库 / 主页 |
| --- | --- | --- | --- |
| `@csstools/color-helpers` | 6.1.1 |  | <https://github.com/csstools/postcss-plugins/tree/main/packages/color-helpers#readme> |
| `@csstools/css-syntax-patches-for-csstree` | 1.1.14 |  | <https://github.com/csstools/postcss-plugins/tree/main/packages/css-syntax-patches-for-csstree#readme> |

### WTFPL（2 个，免声明）

| 包 | 版本 | 作者 | 仓库 / 主页 |
| --- | --- | --- | --- |
| `@azu/style-format` | 1.0.1 | azu | <https://github.com/azu/style-format#readme> |
| `truncate-utf8-bytes` | 1.0.2 | Carl Xiong | <https://github.com/parshap/truncate-utf8-bytes#readme> |

### (MIT AND Zlib)（1 个，表达式）

| 包 | 版本 | 作者 | 仓库 / 主页 |
| --- | --- | --- | --- |
| `pako` | 1.0.11 |  | <https://github.com/nodeca/pako> |

### (MIT OR CC0-1.0)（1 个，表达式）

| 包 | 版本 | 作者 | 仓库 / 主页 |
| --- | --- | --- | --- |
| `type-fest` | 0.13.1, 4.41.0, 5.9.0 | Sindre Sorhus | <https://github.com/sindresorhus/type-fest#readme> |

### (MIT OR GPL-3.0-or-later)（1 个，表达式）

| 包 | 版本 | 作者 | 仓库 / 主页 |
| --- | --- | --- | --- |
| `jszip` | 3.10.1 | Stuart Knightley | <https://github.com/Stuk/jszip#readme> |

### (WTFPL OR MIT)（1 个，表达式）

| 包 | 版本 | 作者 | 仓库 / 主页 |
| --- | --- | --- | --- |
| `utf8-byte-length` | 1.0.5 | Carl Xiong | <https://github.com/parshap/utf8-byte-length#readme> |

### 0BSD（1 个，免声明）

| 包 | 版本 | 作者 | 仓库 / 主页 |
| --- | --- | --- | --- |
| `tslib` | 2.8.1 | Microsoft Corp. | <https://www.typescriptlang.org/> |

### WTFPL OR ISC（1 个，表达式）

| 包 | 版本 | 作者 | 仓库 / 主页 |
| --- | --- | --- | --- |
| `sanitize-filename` | 1.6.4 | Parsha Pourkhomami | <https://github.com/parshap/node-sanitize-filename#readme> |
