import AdmZip from 'adm-zip'

/** 纯文本类扩展名（utf-8 直接读取）。 */
const TEXT_EXT = new Set([
  'txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'jsonl', 'yaml', 'yml', 'xml', 'html', 'htm',
  'js', 'ts', 'jsx', 'tsx', 'py', 'java', 'c', 'h', 'cpp', 'hpp', 'go', 'rs', 'rb', 'php',
  'sql', 'sh', 'bat', 'ps1', 'log', 'ini', 'toml', 'env', 'css', 'scss', 'vue', 'svelte',
])

/**
 * 从上传文件字节中抽取纯文本，供知识库分块/向量化。
 * 支持：文本类扩展名 + docx / pptx / xlsx（OOXML 压缩包内 XML 文本抽取）。
 * 不支持的格式返回空字符串。
 */
export function extractText(filename: string, buffer: Buffer): string {
  const name = (filename ?? '').toLowerCase()
  const ext = name.includes('.') ? name.split('.').pop() ?? '' : ''
  if (ext === 'docx' || ext === 'pptx' || ext === 'xlsx') return extractOoxml(buffer, ext)
  if (TEXT_EXT.has(ext)) return decodeText(buffer)
  // 无扩展名：尝试按 UTF-8 文本解码（去掉可能的前导 BOM）
  return ''
}

function decodeText(buffer: Buffer): string {
  try {
    return buffer.toString('utf-8').replace(/^\uFEFF/, '').replace(/\0/g, '')
  } catch {
    return ''
  }
}

/** 从 OOXML 压缩包中抽取文本（word/document.xml、ppt/slides/*.xml、xl/*.xml）。 */
function extractOoxml(buffer: Buffer, ext: string): string {
  try {
    const zip = new AdmZip(buffer)
    const entries = zip.getEntries()
    const parts: string[] = []

    if (ext === 'docx') {
      const doc = entries.find((e) => !e.isDirectory && e.entryName.toLowerCase() === 'word/document.xml')
      if (doc) pushXmlText(parts, doc.getData().toString('utf-8'))
    } else if (ext === 'pptx') {
      const slides = entries
        .filter((e) => !e.isDirectory && /^ppt\/slides\/slide\d+\.xml$/i.test(e.entryName))
        .sort((a, b) => slideNumber(a.entryName) - slideNumber(b.entryName))
      for (const s of slides) pushXmlText(parts, s.getData().toString('utf-8'))
    } else if (ext === 'xlsx') {
      const shared = entries.find((e) => !e.isDirectory && e.entryName.toLowerCase() === 'xl/sharedstrings.xml')
      const sheets = entries
        .filter((e) => !e.isDirectory && /^xl\/worksheets\/sheet\d+\.xml$/i.test(e.entryName))
        .sort((a, b) => sheetNumber(a.entryName) - sheetNumber(b.entryName))
      for (const s of sheets) pushXmlText(parts, s.getData().toString('utf-8'))
      if (shared) pushXmlText(parts, shared.getData().toString('utf-8'))
    }
    return parts.join('\n\n').replace(/\n{3,}/g, '\n\n').trim()
  } catch {
    return ''
  }
}

function pushXmlText(parts: string[], xml: string): string {
  const text = xmlToText(xml)
  if (text) parts.push(text)
  return text
}

/** 提取 XML 文本节点内容：把块级闭合标签替换为换行，剥离标签，还原实体。 */
function xmlToText(xml: string): string {
  let s = xml
  // 常见块级闭合标签 → 换行
  s = s.replace(/<\/?(?:w|a|m|p|tbl|tr|tc):(?:p|pPr|tr|tc|tbl|t|r)\b[^>]*>/g, '\n')
  // 其它所有标签直接去除
  s = s.replace(/<[^>]+>/g, ' ')
  s = s.replace(/&#(\d+);/g, (_, d) => {
    try {
      return String.fromCodePoint(Number.parseInt(d, 10))
    } catch {
      return ' '
    }
  })
  s = s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  return s.replace(/[ \t]+/g, ' ').replace(/\n\s*\n\s*\n+/g, '\n\n').trim()
}

function slideNumber(name: string): number {
  const m = name.match(/slide(\d+)\.xml/i)
  return m ? Number.parseInt(m[1], 10) : Number.MAX_SAFE_INTEGER
}

function sheetNumber(name: string): number {
  const m = name.match(/sheet(\d+)\.xml/i)
  return m ? Number.parseInt(m[1], 10) : Number.MAX_SAFE_INTEGER
}
