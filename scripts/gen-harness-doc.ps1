$ErrorActionPreference = 'Stop'

# ---------- 工具函数 ----------
function New-Doc {
    $script:word = New-Object -ComObject Word.Application
    $script:word.Visible = $false
    $script:doc = $word.Documents.Add()
    $script:sel = $word.Selection
    $doc.PageSetup.PageWidth  = 595.3
    $doc.PageSetup.PageHeight = 841.9
    $doc.PageSetup.TopMargin    = 72
    $doc.PageSetup.BottomMargin = 72
    $doc.PageSetup.LeftMargin   = 80
    $doc.PageSetup.RightMargin  = 80
}

function Set-Run($fontEast, $fontWest, $size, $bold, $color) {
    $sel.Font.NameFarEast = $fontEast
    $sel.Font.Name = $fontWest
    $sel.Font.Size = [double]$size
    $sel.Font.Bold = $bold
    if ($color) { $sel.Font.Color = $color } else { $sel.Font.Color = 0 }
}

function Add-Para($text, $fontEast='宋体', $fontWest='Times New Roman', $size=11, $bold=$false, $align=3, $indentChars=2, $spaceAfter=6) {
    Set-Run $fontEast $fontWest $size $bold $null
    $sel.ParagraphFormat.Alignment = $align
    $sel.ParagraphFormat.FirstLineIndent = 0
    if ($indentChars -gt 0) {
        $sel.ParagraphFormat.CharacterUnitFirstLineIndent = $indentChars
    }
    $sel.ParagraphFormat.SpaceAfter = $spaceAfter
    $sel.ParagraphFormat.SpaceBefore = 0
    $sel.ParagraphFormat.LineSpacingRule = 1
    $t = ($text -replace "`r`n", ' ' -replace "`n", ' ')
    $sel.TypeText($t)
    $sel.TypeParagraph()
}

function Add-Head1($text) {
    Set-Run '黑体' 'Arial' 18 $true $null
    $sel.ParagraphFormat.Alignment = 0
    $sel.ParagraphFormat.FirstLineIndent = 0
    $sel.ParagraphFormat.CharacterUnitFirstLineIndent = 0
    $sel.ParagraphFormat.SpaceBefore = 18
    $sel.ParagraphFormat.SpaceAfter = 10
    $sel.ParagraphFormat.LineSpacingRule = 1
    $sel.TypeText($text)
    $sel.TypeParagraph()
}

function Add-Head2($text) {
    Set-Run '黑体' 'Arial' 13 $true $null
    $sel.ParagraphFormat.Alignment = 0
    $sel.ParagraphFormat.FirstLineIndent = 0
    $sel.ParagraphFormat.CharacterUnitFirstLineIndent = 0
    $sel.ParagraphFormat.SpaceBefore = 10
    $sel.ParagraphFormat.SpaceAfter = 6
    $sel.ParagraphFormat.LineSpacingRule = 1
    $sel.TypeText($text)
    $sel.TypeParagraph()
}

function Add-Bullet($text) {
    Set-Run '宋体' 'Times New Roman' 11 $false $null
    $sel.ParagraphFormat.Alignment = 0
    $sel.ParagraphFormat.FirstLineIndent = 0
    $sel.ParagraphFormat.CharacterUnitFirstLineIndent = 0
    $sel.ParagraphFormat.LeftIndent = 21
    $sel.ParagraphFormat.SpaceAfter = 4
    $sel.ParagraphFormat.LineSpacingRule = 1
    $sel.TypeText([char]0x2022 + ' ' + ($text -replace "`r`n", ' ' -replace "`n", ' '))
    $sel.TypeParagraph()
}

function Add-Code($text) {
    Set-Run '宋体' 'Consolas' 10 $false $null
    $sel.ParagraphFormat.Alignment = 0
    $sel.ParagraphFormat.FirstLineIndent = 0
    $sel.ParagraphFormat.CharacterUnitFirstLineIndent = 0
    $sel.ParagraphFormat.LeftIndent = 21
    $sel.ParagraphFormat.SpaceAfter = 0
    $sel.ParagraphFormat.SpaceBefore = 0
    $sel.ParagraphFormat.LineSpacingRule = 0
    $sel.ParagraphFormat.Shading.BackgroundPatternColor = 15921906
    foreach ($line in ($text -split "`r?`n")) {
        $sel.TypeText($line)
        $sel.TypeParagraph()
    }
    $sel.ParagraphFormat.Shading.BackgroundPatternColor = 16777215
    $sel.ParagraphFormat.LeftIndent = 0
    $sel.ParagraphFormat.SpaceAfter = 8
}

function Add-Table($headers, $rows, $widths) {
    $cols = $headers.Count
    $r = $rows.Count + 1
    $range = $sel.Range
    $tbl = $doc.Tables.Add($range, $r, $cols)
    $tbl.Style = 'Table Grid'
    $tbl.Range.Font.NameFarEast = '宋体'
    $tbl.Range.Font.Name = 'Times New Roman'
    $tbl.Range.Font.Size = [double]10
    for ($i = 0; $i -lt $cols; $i++) {
        $c = $tbl.Cell(1, $i + 1)
        $c.Range.Text = $headers[$i]
        $c.Range.Font.Bold = $true
        $c.Shading.BackgroundPatternColor = 15921906
        if ($widths -and $widths[$i]) { $tbl.Columns.Item($i + 1).Width = [double]$widths[$i] }
    }
    for ($j = 0; $j -lt $rows.Count; $j++) {
        for ($i = 0; $i -lt $cols; $i++) {
            $c = $tbl.Cell($j + 2, $i + 1)
            $c.Range.Text = [string]$rows[$j][$i]
            $c.Range.Font.Bold = $false
        }
    }
    $sel.EndKey(6) | Out-Null
    $sel.TypeParagraph()
}

function Add-PageBreak {
    $sel.InsertBreak(7)
}

function Save-Doc($path) {
    try {
        $doc.SaveAs([ref]$path, [ref]16)
        $doc.Close()
        try { $word.Quit() } catch { }
        [System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($word) | Out-Null
    } catch {
        try { $word.Quit() } catch { }
        throw
    }
}

# ---------- 生成文档 ----------
New-Doc

# ===== 封面 =====
Add-Para '筑星Harness 使用说明' '黑体' 'Arial' 24 $true 1 0 0
Add-Para '' '宋体' 'Times New Roman' 12 $false 1 0 0
Add-Para '一个帮你干活的 AI 助手' '黑体' 'Arial' 16 $true 1 0 12
Add-Para '给建筑设计师看的简明手册' '黑体' 'Arial' 14 $true 1 0 24
Add-Para '' '宋体' 'Times New Roman' 12 $false 1 0 0
Add-Para '' '宋体' 'Times New Roman' 12 $false 1 0 0
Add-Para '版本 v0.3.4' '黑体' 'Arial' 12 $true 1 0 6
Add-Para '2026年8月' '黑体' 'Arial' 12 $true 1 0 6
Add-PageBreak

# ===== 一、它是什么 =====
Add-Head1 '一、它是什么'
Add-Para @'
一句话：它是个 AI 助手，你说一句，它帮你干活。
'@ -size 12 -bold $true -indentChars 0
Add-Para '它住在你的电脑里。你告诉它要做什么，它会自己翻文件、找资料、动手做，最后把结果交给你。'
Add-Para '电脑上的事，你不用学操作，直接说人话吩咐它就行。'
Add-Para '它记性好。你教过它一次的事，下次它自己记得，不用重复说。'
Add-Para '它是可以换的。它背后接的 AI 服务、用的工具，都可以按你的需要换。'

# ===== 二、它能帮你做什么 =====
Add-Head1 '二、它能帮你做什么'
Add-Bullet '整理资料：把一整个项目文件夹的图纸、说明、变更单，理成清单，一目了然。'
Add-Bullet '找东西：在成堆文件里找出你要的那一份，或找出所有提到"面积""防火分区"的地方。'
Add-Bullet '写初稿：把方案要点说给它，它起草方案、说明、给甲方的邮件，你再改，省大半时间。'
Add-Bullet '认图识字：把图纸、截图里的文字认出来，变成能直接编辑的文字稿。'
Add-Bullet '干重复活：批量改名、批量导出 PDF、按规则整理文件，说一遍它就做。'
Add-Bullet '查资料：问它规范条文、材料参数，它去帮你找答案。'
Add-Bullet '汇总汇报：把零散信息整理成一段话，直接能发。'

# ===== 三、怎么开始用 =====
Add-Head1 '三、怎么开始用（三步）'
Add-Head2 '第 1 步：装好'
Add-Para '用安装包双击安装，免管理员，几分钟装完。也可以用一行命令装，想用哪种都行。'
Add-Head2 '第 2 步：配好'
Add-Para '双击桌面上的"筑星Harness Web UI"图标，浏览器会打开一个网页。第一次用，把 AI 服务的密钥填一次，就像第一次登录软件，之后就不用管了。'
Add-Head2 '第 3 步：开聊'
Add-Para '在对话框里说你要什么，看着它一步步做，做完把结果拿走。'

# ===== 四、直接能用的例子 =====
Add-Head1 '四、直接能用的例子'
Add-Para '下面这些话，复制到对话框就能用：'
Add-Code @'
帮我把 D盘\XX项目 里的文件列成清单
找出这个文件夹里所有提到"变更"的文件
帮我写一封给甲方的邮件，催他们确认方案，语气客气点
把这几个文件批量改名为"1号楼图纸-01"这种格式
把这张图片里的文字认出来，整理成文字稿
'@

# ===== 五、几个词的大白话解释 =====
Add-Head1 '五、几个词的大白话解释'
Add-Table @('词', '什么意思') @(
  @('插件', '给助手加的本事。想要它会新技能，装个插件就行。'),
  @('技能', '现成的工作模板。比如"按公司格式写方案""做设计评审"，装上就能用。'),
  @('记忆', '助手的小本子。你教过一次的偏好，它记下来，以后自动照着做。'),
  @('子模型', '助手背后有几个不同专长的"同事"，它自动挑合适的人干活。'),
  @('权限', '你能限制它动你多少东西：只能看、能改当前项目文件夹、什么都能动。'),
  @('更新', '它自己升级，一条命令，几分钟就好。')
) @(90, 430)

# ===== 六、安全提醒 =====
Add-Head1 '六、安全提醒（务必看）'
Add-Bullet '默认权限是"什么都能动"，自己电脑上用没问题；但建议日常工作改成"只能改当前项目文件夹"，更稳妥。'
Add-Bullet '它会联网向 AI 服务提问，涉及保密的内容，先想清楚再发。'
Add-Bullet '重要文件动手前先备份。给权限前，想清楚这个活值不值得让它碰。'

# ===== 七、卡住了怎么办 =====
Add-Head1 '七、卡住了怎么办'
Add-Bullet '没反应：等半分钟，有些活比较慢。'
Add-Bullet '一直不动：重开一个对话，再说一遍。'
Add-Bullet '结果不对：把要求说具体点，比如"只整理 PDF 文件，要表格"。'
Add-Bullet '找不到文件：告诉它完整的文件夹路径。'

# ===== 结语 =====
Add-Head1 '结语'
Add-Para '它就是你的帮手。把重复的、费神的活交给它，你把时间留给设计。'
Add-Para '' '宋体' 'Times New Roman' 12 $false 3 0 0
Add-Para '—— 筑星Harness v0.3.4 ——' '黑体' 'Arial' 12 $true 3 0 6

# ---------- 保存 ----------
$out = 'C:\Users\HarryBrowne\Desktop\筑星Harness（Agent运行时）_产品介绍与使用手册.docx'
Save-Doc $out
Write-Output ('SAVED: ' + $out)
