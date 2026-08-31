/* eslint-disable */
// 生成《筑星Harness 用户手册》Word 文档（.docx）
// 依赖项目已有的 adm-zip 打包合法 docx。可重复运行，覆盖输出。
const fs = require('fs')
const path = require('path')
const AdmZip = require('E:/筑星Harness/node_modules/adm-zip')

const OUT = path.join('E:/筑星Harness', '筑星Harness-用户手册-0.3.7.docx')

/** XML 转义。 */
function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/** 段落（正文）。level 用于标题，0=正文。 */
function p(text, opts = {}) {
  const style = opts.style
  const props = []
  if (style) props.push(`<w:pStyle w:val="${style}"/>`)
  if (opts.bold) props.push('<w:rPr><w:b/></w:rPr>')
  const pPr = props.length ? `<w:pPr>${props.join('')}</w:pPr>` : ''
  return `<w:p>${pPr}<w:r><w:rPr><w:rFonts w:ascii="微软雅黑" w:hAnsi="微软雅黑" w:eastAsia="微软雅黑"/>${opts.bold ? '<w:b/>' : ''}</w:rPr><w:t xml:space="preserve">${esc(text)}</w:t></w:r></w:p>`
}

/** 标题。 */
function heading(text, level) {
  const style = level === 1 ? 'Heading1' : level === 2 ? 'Heading2' : 'Heading3'
  const size = level === 1 ? '36' : level === 2 ? '30' : '26'
  const color = level === 1 ? '1F3864' : level === 2 ? '2E5596' : '3F6CB0'
  return `<w:p><w:pPr><w:pStyle w:val="${style}"/></w:pPr><w:r><w:rPr><w:rFonts w:ascii="微软雅黑" w:hAnsi="微软雅黑" w:eastAsia="微软雅黑"/><w:b/><w:sz w:val="${size}"/><w:color w:val="${color}"/></w:rPr><w:t xml:space="preserve">${esc(text)}</w:t></w:r></w:p>`
}

/** 项目符号列表项。 */
function bullet(text, level = 0) {
  const indent = level * 2
  return `<w:p><w:pPr><w:pStyle w:val="ListParagraph"/><w:ind w:left="${440 + indent * 360}" w:hanging="360"/><w:numPr><w:ilvl w:val="${level}"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:rPr><w:rFonts w:ascii="微软雅黑" w:hAnsi="微软雅黑" w:eastAsia="微软雅黑"/></w:rPr><w:t xml:space="preserve">${esc(text)}</w:t></w:r></w:p>`
}

/** 编号列表项。 */
function numbered(text, level = 0) {
  const indent = level * 2
  return `<w:p><w:pPr><w:pStyle w:val="ListParagraph"/><w:ind w:left="${440 + indent * 360}" w:hanging="360"/><w:numPr><w:ilvl w:val="${level}"/><w:numId w:val="2"/></w:numPr></w:pPr><w:r><w:rPr><w:rFonts w:ascii="微软雅黑" w:hAnsi="微软雅黑" w:eastAsia="微软雅黑"/></w:rPr><w:t xml:space="preserve">${esc(text)}</w:t></w:r></w:p>`
}

/** 强调/提示块（浅底色段落）。 */
function tip(text) {
  return `<w:p><w:pPr><w:shd w:val="clear" w:fill="EEF3FB"/></w:pPr><w:r><w:rPr><w:rFonts w:ascii="微软雅黑" w:hAnsi="微软雅黑" w:eastAsia="微软雅黑"/><w:color w:val="1F3864"/></w:rPr><w:t xml:space="preserve">${esc(text)}</w:t></w:r></w:p>`
}

/** 分隔线。 */
function hr() {
  return `<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="D0D0D0"/></w:pBdr></w:pPr><w:r/></w:p>`
}

/** 代码块（等宽）。 */
function code(text) {
  const lines = String(text).split('\n').map((l) => `<w:p><w:pPr><w:ind w:left="280"/></w:pPr><w:r><w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:eastAsia="微软雅黑"/><w:sz w:val="20"/></w:rPr><w:t xml:space="preserve">${esc(l)}</w:t></w:r></w:p>`)
  return `<w:p><w:pPr><w:shd w:val="clear" w:fill="F5F5F5"/><w:pBdr><w:top w:val="single" w:sz="4" w:color="DDDDDD"/><w:left w:val="single" w:sz="4" w:color="DDDDDD"/><w:bottom w:val="single" w:sz="4" w:color="DDDDDD"/><w:right w:val="single" w:sz="4" w:color="DDDDDD"/></w:pBdr></w:pPr><w:r/></w:p>${lines.join('')}`
}

/** 生成 Word 文档。 */
function buildDocx(title, bodyXml) {
  const zip = new AdmZip()

  // [Content_Types].xml
  zip.addFile('[Content_Types].xml', Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
  <Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
</Types>`, 'utf-8'))

  // _rels/.rels
  zip.addFile('_rels/.rels', Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>`, 'utf-8'))

  // word/_rels/document.xml.rels
  zip.addFile('word/_rels/document.xml.rels', Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`, 'utf-8'))

  // word/styles.xml
  zip.addFile('word/styles.xml', Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:docDefaults>
    <w:rPrDefault>
      <w:rPr><w:rFonts w:ascii="微软雅黑" w:hAnsi="微软雅黑" w:eastAsia="微软雅黑"/><w:sz w:val="22"/><w:szCs w:val="22"/></w:rPr>
    </w:rPrDefault>
    <w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="300" w:lineRule="auto"/></w:pPr></w:pPrDefault>
  </w:docDefaults>
  <w:style w:type="paragraph" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
  <w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="Heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="240" w:after="120"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="36"/><w:color w:val="1F3864"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="Heading 2"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="200" w:after="100"/><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:b/><w:sz w:val="30"/><w:color w:val="2E5596"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="Heading 3"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="160" w:after="80"/><w:outlineLvl w:val="2"/></w:pPr><w:rPr><w:b/><w:sz w:val="26"/><w:color w:val="3F6CB0"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/><w:pPr><w:ind w:left="440"/><w:spacing w:after="40"/></w:pPr></w:style>
</w:styles>`, 'utf-8'))

  // word/document.xml
  zip.addFile('word/document.xml', Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<w:body>
${bodyXml}
<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr>
</w:body>
</w:document>`, 'utf-8'))

  // docProps/core.xml
  zip.addFile('docProps/core.xml', Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <dc:title>${esc(title)}</dc:title>
  <dc:creator>筑星 Harness</dc:creator>
  <dc:subject>新用户使用手册</dc:subject>
  <dc:description>筑星 Harness v0.3.7 新用户配置与功能说明</dc:description>
</cp:coreProperties>`, 'utf-8'))

  // docProps/app.xml
  zip.addFile('docProps/app.xml', Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties">
  <Application>筑星 Harness</Application>
  <DocSecurity>0</DocSecurity>
  <ScaleCrop>false</ScaleCrop>
  <Company>Zhuxing</Company>
  <AppVersion>0.3.7</AppVersion>
</Properties>`, 'utf-8'))

  zip.writeZip(OUT)
  return OUT
}

// ===== 正文内容 =====
const body = []
body.push(p('筑星 Harness v0.3.7 —— 新用户使用手册', { bold: true }))
body.push(p('版本：0.3.7 ｜ 适用对象：第一次使用筑星 Harness 的你'))
body.push(hr())
body.push(heading('一、筑星 Harness 是什么？', 1))
body.push(p('用一句话说：筑星 Harness 是一个「AI 全能助手」。'))
body.push(p('你像和一位很能干的助理聊天一样，用普通中文把想做的事告诉它，它会自己判断该用什么「工具」来完成——比如读文件、查目录、运行命令、看图片、生成图片、生成视频、生成语音、记住你的喜好、从知识库查资料等等。整个过程你只需要开口说，它来做。'))
body.push(p('它有两大用法：'))
body.push(bullet('网页版（推荐新手）：一个在浏览器里打开的漂亮界面，点几下就能配置和对话。'))
body.push(bullet('命令行版：在终端输入 harness 命令，适合习惯命令行的用户，也能写脚本自动化。'))
body.push(tip('小提醒：本手册主要面向「网页版」新手。网页版已经覆盖了最常用的所有能力。'))

body.push(heading('二、快速上手：5 分钟跑起来', 1))
body.push(numbered('双击安装包「zhuxing-harness-setup-0.3.7.exe」，一路下一步即可完成安装。'))
body.push(numbered('安装后，在「开始菜单」找到并打开「筑星 Harness」，或直接在浏览器访问 http://127.0.0.1:3080 。'))
body.push(numbered('首次打开会看到「先连接你的模型」的引导页，点击「打开设置」。'))
body.push(numbered('在设置里填写「API 密钥」（Key）和「模型名」，点保存。'))
body.push(numbered('回到对话界面，在输入框里输入任务，按 Enter 或点「发送」即可开始。'))
body.push(code('首次配置一般只需要两样东西：\n① API 密钥（模型服务商给你的一串 sk- 开头的字符）\n② 模型名（例如 deepseek-v4-flash / deepseek-v4-pro）'))
body.push(tip('没有 API 密钥？你可以去模型平台注册（例如 DeepSeek 开放平台），创建一个 Key。也支持任意「OpenAI 兼容」的模型端点。'))

body.push(heading('三、设置面板：每个分区干什么', 1))
body.push(p('点击界面左下角「⚙ 设置」，会打开一个分成多个「页签（Tab）」的设置窗口。下面逐个解释，你只需要看自己用的部分。'))

body.push(heading('1. 主模型（最常用，必配）', 2))
body.push(bullet('API Key（密钥）：必填。相当于你的「账号密码」，填模型服务商给你的 Key。'))
body.push(bullet('端点地址（Base URL）：模型服务的网址，一般有默认值，不用改。'))
body.push(bullet('模型名：用哪个模型，例如 deepseek-v4-flash（便宜、快）或 deepseek-v4-pro（更强）。'))
body.push(bullet('主模型支持多模态（图片）：勾选后，主模型就能「看图片」。这是实现「截图/OCR/看图」的关键开关。'))
body.push(tip('重要：要把功能做到「能看图、能识别截图里的文字」，请确保：①勾选「主模型支持多模态」；②所用模型本身支持读图（如带 vision/视觉能力的模型）。'))

body.push(heading('2. 子模型（进阶，可多模型分工）', 2))
body.push(p('你可以挂多个不同「擅长方向」的模型。主模型会像「项目负责人」一样，根据任务难度自动把活派给合适的子模型（比如写代码的、做推理的、看图的），哪个合适选哪个。'))
body.push(bullet('ID：给这个模型起的代号（英文）。'))
body.push(bullet('模型名 / 显示名：对应的模型标识。'))
body.push(bullet('上下文窗口：它能一次记住多少内容，一般不用填。'))
body.push(bullet('能力标签（点选）：如 代码、推理、创意、分析、快速、经济、长上下文、视觉、通用。勾选「视觉」的模型才能被派去「看图/OCR」任务。'))
body.push(bullet('独立端点与 Key：每个模型可以有自己的网址和密钥。'))
body.push(p('不填也没关系——不配置子模型，就用主模型一个也完全够用。'))

body.push(heading('3. 生图模型', 2))
body.push(p('配置了生图模型后，Agent 就多出一个「生成图片」的能力：你告诉它想画什么，它生成一张图片。'))
body.push(bullet('模型：生图模型名，例如 qwen-image、wan2.7-image、dall-e-3。'))
body.push(bullet('端点 / API Key：一般回退用主模型那套，可以单独填。'))
body.push(bullet('尺寸：默认图片大小，如 1024*1024。'))
body.push(bullet('协议模式：如果用阿里云百炼的 qwen-image 系列，选「DashScope 原生」；其他 OpenAI 兼容的选默认即可。'))

body.push(heading('4. 阿里云百炼聚合（token-plan）—— 一个 Key 挂多种能力', 2))
body.push(p('如果你使用的是阿里云百炼的聚合平台，一个 Key 就能同时启用「生成图片 / 生成视频 / 生成语音」，还能挂多个文本子模型。'))
body.push(bullet('API Key：token-plan 专用 Key。'))
body.push(bullet('文本子模型：注册进路由，供主模型派活。'))
body.push(bullet('生图模型：启用生成图片。'))
body.push(bullet('视频生成模型：启用生成视频。'))
body.push(bullet('语音合成模型：启用生成语音。'))
body.push(bullet('Realtime 模型：实时语音对话（当前为占位，暂未接入）。'))
body.push(p('一句话理解：这个分区是「一个平台入口，多个能力同时开」。不适用就跳过。'))

body.push(heading('5. 专业化能力包（面向专业领域的增量包）', 2))
body.push(p('这是 0.3.7 新增的能力。专业化能力包把某一专业领域（比如建筑、电网）的「技能 + 内置知识」打包成一个 .zip 文件。安装后，它会自动把技能注册进技能系统、把内置知识文档放进知识库；你可以按需启用或禁用，禁用后自动隔离、不影响普通功能。'))
body.push(bullet('安装：在「专业化」页签选择 .zip 能力包 → 点「安装并启用」。'))
body.push(bullet('启用/禁用：已安装的包可随时开启或关闭。'))
body.push(bullet('移除：不再需要时可移除，其技能与知识将不再参与。'))
body.push(tip('一个能力包通常包含 manifest.json + skills/*.yaml + knowledge/*。装好后就能在对话/知识库里使用该专业的能力与资料。'))

body.push(heading('6. 记忆', 2))
body.push(p('让 Agent 跨对话记住你的偏好。比如「我一向喜欢简洁的回答」，它会记住并在以后自动遵守。'))
body.push(bullet('记忆分「跨项目 / 本项目 / 自动学习 / 仅当前对话」几种范围。'))
body.push(bullet('你可以在「记忆」页签查看、添加或删除记忆。'))

body.push(heading('7. 技能', 2))
body.push(p('一整套可复用的「经验模板」。你可以把某类任务的步骤存成技能，下次一键复用。'))
body.push(bullet('支持上传 .yaml / .zip 技能包。'))
body.push(bullet('在对话里输入 /技能名 也能快速触发。'))
body.push(bullet('在「技能」页签可以新建、删除、查看技能。'))

body.push(heading('8. 工具', 2))
body.push(p('列出现有全部「工具」及说明，可以逐个「测试」跑一遍，直观了解 Agent 拥有哪些能力。'))

body.push(heading('9. 运行环境', 2))
body.push(bullet('工作区：Agent 干活时「活动的文件夹」。留空会用一个临时空目录。'))
body.push(bullet('一键选择：可以用「选择目录」选电脑里的文件夹，或用「临时工作区」立刻生成一个临时目录。'))
body.push(bullet('沙箱级别：控制它有多「自由」。'))
body.push(numbered('danger-full-access（默认）：最高权限，全放行。新手用这个最省心。'))
body.push(numbered('workspace-write：只允许在工作区内写文件。'))
body.push(numbered('read-only：只读，不能写文件。'))
body.push(tip('安全建议：如果工作区里没有重要文件，直接用默认最高权限即可；若担心误操作，选「只读」最保险。'))

body.push(heading('10. 更新', 2))
body.push(p('检查并安装新版本。点击「检查更新」看是否有新版，有的话可以一键更新。'))

body.push(heading('四、它到底能帮你做什么？（功能清单）', 1))
body.push(p('下面把这些能力说得大白话，方便你知道「能交给它做什么」。'))

body.push(heading('1. 对话与总结', 2))
body.push(bullet('回答问题、写文案、改文章、头脑风暴。'))
body.push(bullet('「总结当前目录结构」「阅读 README 并总结」这类日常任务。'))

body.push(heading('2. 读写文件、运行命令', 2))
body.push(bullet('查看文件内容（read_file）。'))
body.push(bullet('新建/修改文件（write_file）。'))
body.push(bullet('列出文件夹内容（list_dir）。'))
body.push(bullet('在系统里执行命令（shell）。'))
body.push(bullet('把文件拖进输入框，或点「选择文件 / 选择文件夹」，Agent 会处理这些文件。'))

body.push(heading('3. 看图 / 截图识别 / OCR', 2))
body.push(p('你可以直接把图片「拖进来」或「粘贴」到输入框——比如一张截图、一张照片、一页扫描件，Agent 会「看懂」并帮你读出里面的文字、描述画面内容、或者根据图片回答。'))
body.push(bullet('拖入图片 → 自动作为「图片附件」发送。'))
body.push(bullet('识别截图/照片里的文字（OCR）。'))
body.push(bullet('看图问答：比如「这张图里有什么？」「帮我看一下这个报错截图」。'))
body.push(tip('要用好这个功能：①在「主模型」页签勾选「主模型支持多模态」；②使用具备「视觉」能力的模型（配置子模型时勾选「视觉」标签，或用支持读图的主模型）。'))

body.push(heading('4. 生成图片', 2))
body.push(p('配置了「生图模型」后，直接说想画什么，它生成一张图片返回。'))
body.push(code('例如：\n「画一只在星空下看书的橘猫」 → 得到一张生成的图片'))

body.push(heading('5. 生成视频', 2))
body.push(p('配置了视频生成模型后，描述一段动态画面，它会生成一段 MP4 视频。支持文生视频、图生视频、视频重绘，可设置分辨率、比例、时长。'))

body.push(heading('6. 生成语音', 2))
body.push(p('配置语音模型后，把文字转成语音（TTS），生成 mp3 音频文件。'))

body.push(heading('7. 多子模型自动分工', 2))
body.push(p('挂了多个子模型后，主模型会根据任务「聪明地」选人：写代码的选代码强的，看图的选带视觉的，复杂的选推理强的，简单的选快又省的。你无需操心。'))

body.push(heading('8. 跨对话记忆', 2))
body.push(bullet('记住你的偏好、常用习惯、项目背景。'))
body.push(bullet('记忆分「跨项目/本项目/自动学习/仅当前对话」几种范围，你可以在设置里查看和管理。'))

body.push(heading('9. 技能模板', 2))
body.push(p('把一个反复要用的任务流程存成「技能」，下次直接调用，省去重复描述。'))
body.push(code('输入 /技能名 也能快速触发：\n/skill 我的报告模板 参数……'))

body.push(heading('10. 空间（项目）管理', 2))
body.push(bullet('把不同主题的对话分到不同「空间（项目）」里，互不干扰，更清爽。'))

body.push(heading('11. 对话分叉 / 合并', 2))
body.push(bullet('从一个对话「分叉」出子对话，单独探索，再把结论「合并」回主对话。适合多条思路并行。'))

body.push(heading('12. 文件预览', 2))
body.push(p('拖进来的文件可以预览：PDF、Word（.docx）、Excel（.xlsx）、PPT（.pptx）、以及文本类文件。'))

body.push(heading('13. 知识库（自生长知识库 / RAG）—— 本版重点', 2))
body.push(p('这是 0.3.7 新增的全新能力。你可以把文档、资料、规范等上传到「知识库」，之后 Agent 就能在对话中基于这些资料回答你的问题，并标注来源。'))
body.push(bullet('在左侧栏点「知识库」进入知识库页面。'))
body.push(bullet('上传：支持 txt/md/csv/json/yaml/code 及 docx/pptx/xlsx 等文件；也可以直接粘贴文字入库。'))
body.push(bullet('自动分块：上传的文档会自动切分成小片段（chunk）。'))
body.push(bullet('语义检索（RAG）：在知识库设置里配置「Embedding」（baseUrl + apiKey + 模型）后，即可按语义搜索；未配置时自动降级为关键词匹配。'))
body.push(bullet('知识空间与目录：可建多个知识空间，空间下还能建多层目录来归档文档。'))
body.push(bullet('知识库问答（带溯源）：针对某个空间提问，AI 基于检索片段作答，并在句末标注 [1][2] 来源编号，可点击溯源到原文词条。'))
body.push(bullet('信息链接图谱：以图谱形式可视化文档与标签之间的关联。'))
body.push(bullet('命中内容会注入到每次对话的 systemPrompt（上限 8KB），让 AI 在对话中自动用上知识库资料。'))
body.push(tip('小提示：要启用完整「语义检索」，需配置知识库的 Embedding（一个 OpenAI 兼容的 /embeddings 接口）。没有的话也能用，只是按关键词匹配。'))

body.push(heading('14. 专业化能力包', 2))
body.push(p('安装某个专业领域的能力包后，该领域的「技能 + 内置知识」就齐了。可以在对话里直接用，也能在知识库里检索到对应的专业资料。'))

body.push(heading('五、常见问题（FAQ）', 1))
body.push(numbered('API 密钥在哪找？→ 去你选择的模型平台（如 DeepSeek 开放平台）注册并创建密钥。'))
body.push(numbered('为什么不能看图/OCR？→ 检查是否勾选了「主模型支持多模态」，并且所用模型支持读图。'))
body.push(numbered('为什么没有生图/生视频/生语音按钮？→ 需要在设置里先配置对应的“生图模型”或“token-plan”相关模型，配置后这些能力会自动出现。'))
body.push(numbered('工作区是什么？→ Agent 干活时读写文件的“地盘”，可以选一个专门的空文件夹，更安全。'))
body.push(numbered('想让 Agent 记住我的偏好？→ 在对话里说“记住我喜欢简洁回答”，它会存进记忆；也可在设置“记忆”里查看/删除。'))
body.push(numbered('怎么切换模型？→ 在主模型页签改模型名即可；若要自动分工，去“子模型”页签配置。'))
body.push(numbered('知识库怎么用？→ 先到「知识库」页面上传文档；若要语义检索，在知识库设置里配置 Embedding。之后对话时 AI 会自动调用 search_knowledge 检索作答。'))
body.push(numbered('专业化能力包怎么装？→ 在「设置 → 专业化」页签选择一个 .zip 能力包，点「安装并启用」。'))

body.push(hr())
body.push(p('希望这份手册能帮你快速上手。打开界面，说一句「总结当前目录结构」或「帮我看这张截图」，就能立刻感受它的能力。', { bold: true }))
body.push(p('—— 筑星 Harness 团队'))

const out = buildDocx('筑星 Harness 用户手册（0.3.7）', body.join('\n'))
console.log('已生成：' + out)
