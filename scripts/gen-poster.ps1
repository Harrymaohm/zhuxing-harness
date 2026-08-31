Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms

# --- 用码点构造中文，避免 PS5.1 中文编码坑 ---
$title   = -join ([char]0x7B51,[char]0x661F,[char]0x8BA1,[char]0x5212)   # 筑星计划
$sub     = -join ([char]0x8BA9,[char]0x5EFA,[char]0x9020,[char]0x66F4,[char]0x667A,[char]0x80FD)  # 让建造更智能
$tagline = -join ([char]0x667A,[char]0x80FD,[char]0x5EFA,[char]0x7B51,[char]0x672A,[char]0x6765)  # 智慧筑未来

$W = 1024
$H = 1536
$bmp = [System.Drawing.Bitmap]::new($W,$H)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAlias

# --- 深蓝渐变背景 ---
$c1 = [System.Drawing.Color]::FromArgb(255, 8, 16, 48)
$c2 = [System.Drawing.Color]::FromArgb(255, 24, 42, 120)
$c3 = [System.Drawing.Color]::FromArgb(255, 40, 22, 90)
$rect = [System.Drawing.Rectangle]::new(0,0,$W,$H)
$grad = [System.Drawing.Drawing2D.LinearGradientBrush]::new($rect, $c1, $c3, [single]45)
$g.FillRectangle($grad, $rect)

# --- 一圈星光小点装饰 ---
$rand = [System.Random]::new(2026)
for($i=0;$i -lt 90;$i++){
  $sx = $rand.Next(0,$W)
  $sy = $rand.Next(0,$H)
  $r  = $rand.Next(1,4)
  $g.FillEllipse([System.Drawing.Brushes]::White, $sx, $sy, $r, $r)
}

# --- 中央大星星（四角星，用多边形） ---
$cx = [single]($W/2)
$cy = [single]560
$R  = [single]170
$r2 = [single]46
$spikes = 4
$pts = [System.Drawing.PointF[]]::new($spikes*2)
for($i=0;$i -lt $spikes*2;$i++){
  if($i % 2 -eq 0){ $rad=$R } else { $rad=$r2 }
  $ang = -([Math]::PI/2) + $i*([Math]::PI/$spikes)
  $x = $cx + $rad*[Math]::Cos($ang)
  $y = $cy + $rad*[Math]::Sin($ang)
  $pts[$i] = [System.Drawing.PointF]::new($x,$y)
}
$starColor = [System.Drawing.Color]::FromArgb(255,255,214,64)
$starPen = [System.Drawing.Pen]::new($starColor,6)
$starBrush = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(220,255,214,64))
$g.FillPolygon($starBrush,$pts)
$g.DrawPolygon($starPen,$pts)

# 星星中心光晕
$glow = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(60,255,255,255))
$g.FillEllipse($glow, $cx-220, $cy-220, 440, 440)

# --- 标题：筑星计划 ---
$fontTitle = [System.Drawing.Font]::new("Microsoft YaHei",100,[System.Drawing.FontStyle]::Bold)
$tf = [System.Drawing.StringFormat]::new()
$tf.Alignment = [System.Drawing.StringAlignment]::Center
$g.DrawString($title, $fontTitle, [System.Drawing.Brushes]::White, [single]($W/2), 880, $tf)

# --- 副标题：让建造更智能 ---
$fontSub = [System.Drawing.Font]::new("Microsoft YaHei",34,[System.Drawing.FontStyle]::Regular)
$subBrush = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(255,180,210,255))
$g.DrawString($sub, $fontSub, $subBrush, [single]($W/2), 1040, $tf)

# --- 分割线 ---
$linePen = [System.Drawing.Pen]::new([System.Drawing.Color]::FromArgb(120,255,214,64),2)
$g.DrawLine($linePen, 270, 1160, ($W-270), 1160)

# --- 底部标语：智慧筑未来 ---
$fontTag = [System.Drawing.Font]::new("Microsoft YaHei",26,[System.Drawing.FontStyle]::Regular)
$tagBrush = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(220,200,210,255))
$g.DrawString($tagline, $fontTag, $tagBrush, [single]($W/2), 1200, $tf)

# --- 底部抽象建筑轮廓线条 ---
$buildPen = [System.Drawing.Pen]::new([System.Drawing.Color]::FromArgb(90,120,160,255),2)
for($b=0;$b -lt 7;$b++){
  $bx = 90 + $b*120
  $bh = 90 + ($b%3)*48
  $g.DrawRectangle($buildPen, $bx, 1420-$bh, 70, $bh)
}

$out = Join-Path ([Environment]::GetFolderPath('Desktop')) '筑星计划海报.png'
$bmp.Save($out,[System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose();$bmp.Dispose()
Write-Output ("SAVED: " + $out)
