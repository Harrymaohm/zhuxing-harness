// 把《筑星Harness 用户手册》的 .docx 转成同名 .pdf（用 Word COM，规避中文路径编码问题）
// 用法：node scripts/docx-to-pdf.cjs <您的docx路径>
// 若不传参，默认处理最新版手册
const { spawnSync } = require('child_process')
const fs = require('fs')
const path = require('path')

const DEFAULT_DOCX = path.join('E:/筑星Harness', '筑星Harness-用户手册-0.3.9.docx')
const docxPath = process.argv[2] || DEFAULT_DOCX

if (!fs.existsSync(docxPath)) {
  console.error('找不到 docx：' + docxPath)
  process.exit(1)
}

const pdfPath = docxPath.replace(/\.docx$/i, '.pdf')
const dir = path.dirname(docxPath)
const tmpDst = path.join(dir, '_tmp_convert_out.pdf')
if (fs.existsSync(tmpDst)) fs.rmSync(tmpDst, { force: true })

// 用英文路径做转换，避免中文路径在 PowerShell 脚本中乱码
const ps = `
$ErrorActionPreference = 'Stop'
$src = ${JSON.stringify(docxPath.replace(/\\/g, '\\\\'))}
$dst = ${JSON.stringify(tmpDst.replace(/\\/g, '\\\\'))}
$w = $null
try {
  $w = New-Object -ComObject Word.Application
  $w.Visible = $false
  $w.DisplayAlerts = 0
  $doc = $w.Documents.Open($src, $false, $true)
  $doc.SaveAs([ref]$dst, [ref]17)
  $doc.Close($false)
  if (Test-Path $dst) { Write-Output ('OK:' + (Get-Item $dst).Length) } else { Write-Output 'FAIL:no output' }
} catch {
  Write-Output ('FAIL:' + $_.Exception.Message)
} finally {
  if ($w) { try { $w.Quit() } catch {} }
}
`

const res = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps], { encoding: 'utf8', timeout: 60000 })
const out = (res.stdout || '').replace(/^\s+|\s+$/g, '')

if (res.status === 0 || out.startsWith('OK:')) {
  if (fs.existsSync(tmpDst)) {
    fs.copyFileSync(tmpDst, pdfPath)
    const size = fs.statSync(pdfPath).size
    fs.rmSync(tmpDst, { force: true })
    console.log('转换成功：' + pdfPath + ' (' + size + ' 字节)')
    process.exit(0)
  } else {
    console.error('转换失败：未生成 PDF 文件')
    process.exit(1)
  }
} else {
  console.error('转换失败：' + out)
  process.exit(1)
}
