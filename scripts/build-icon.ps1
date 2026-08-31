﻿﻿﻿# Generate full multi-size ICO (16~256) and overwrite the app icon source.
# Source: extract the 256x256 PNG inside the existing .ico, scale to each size
# (32bit BGRA DIB + zero AND mask), assemble into an ICO container.
# Run: powershell -NoProfile -ExecutionPolicy Bypass -File scripts\build-icon.ps1
Add-Type -AssemblyName System.Drawing

$src = 'E:\筑星Harness\kk6zc-wyj96-001.ico'

# 1. Extract the largest PNG image as the hi-res source
$bytes = [IO.File]::ReadAllBytes($src)
$count = [BitConverter]::ToUInt16($bytes, 4)
$best = $null
for ($i = 0; $i -lt $count; $i++) {
  $o = 6 + $i * 16
  $w = $bytes[$o]
  $h = $bytes[$o + 1]
  $sz = [BitConverter]::ToUInt32($bytes, $o + 8)
  $off = [BitConverter]::ToUInt32($bytes, $o + 12)
  $px = 256
  if ($w -ne 0) { $px = $w }
  if (-not $best -or $px -ge $best.w) { $best = @{ w = $px; off = $off; sz = $sz } }
}
if (-not $best) { throw 'no image found in icon' }
$png = [byte[]]::new($best.sz)
[Array]::Copy($bytes, $best.off, $png, 0, $best.sz)
$pngPath = Join-Path $env:TEMP 'zhx-icon-256.png'
[IO.File]::WriteAllBytes($pngPath, $png)
Write-Output ("source: {0}x{0} PNG extracted" -f $best.w)

# 2. Build DIB data for each size
$sizes = 16, 20, 24, 32, 40, 48, 64, 128, 256
$images = @()
$srcImg = [System.Drawing.Image]::FromFile($pngPath)
foreach ($s in $sizes) {
  $bmp = New-Object System.Drawing.Bitmap($s, $s, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.Clear([System.Drawing.Color]::Transparent)
  $g.DrawImage($srcImg, 0, 0, $s, $s)
  $g.Dispose()

  $rect = New-Object System.Drawing.Rectangle(0, 0, $s, $s)
  $data = $bmp.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::ReadOnly, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $stride = $data.Stride
  $pix = [byte[]]::new($s * $s * 4)
  [System.Runtime.InteropServices.Marshal]::Copy($data.Scan0, $pix, 0, $pix.Length)
  $bmp.UnlockBits($data)
  $bmp.Dispose()

  # flip to bottom-up and keep BGRA order
  $xor = [byte[]]::new($s * $s * 4)
  for ($y = 0; $y -lt $s; $y++) {
    $srcRow = $y * $stride
    $dstRow = ($s - 1 - $y) * $s * 4
    for ($x = 0; $x -lt $s; $x++) {
      $si = $srcRow + $x * 4
      $di = $dstRow + $x * 4
      $xor[$di] = $pix[$si]
      $xor[$di + 1] = $pix[$si + 1]
      $xor[$di + 2] = $pix[$si + 2]
      $xor[$di + 3] = $pix[$si + 3]
    }
  }
  # AND mask: all zero (alpha icon)
  $maskRow = [Math]::Ceiling($s / 32) * 4
  $and = [byte[]]::new($maskRow * $s)

  # BITMAPINFOHEADER (40 bytes)
  $hdr = [byte[]]::new(40)
  [BitConverter]::GetBytes([int]40).CopyTo($hdr, 0)
  [BitConverter]::GetBytes([int]$s).CopyTo($hdr, 4)
  [BitConverter]::GetBytes([int]($s * 2)).CopyTo($hdr, 8)
  [BitConverter]::GetBytes([int16]1).CopyTo($hdr, 12)
  [BitConverter]::GetBytes([int16]32).CopyTo($hdr, 14)
  [BitConverter]::GetBytes([int]0).CopyTo($hdr, 16)

  $dib = [byte[]]::new($hdr.Length + $xor.Length + $and.Length)
  $hdr.CopyTo($dib, 0)
  $xor.CopyTo($dib, $hdr.Length)
  $and.CopyTo($dib, $hdr.Length + $xor.Length)
  $images += @{ w = $s; h = $s; data = $dib }
  Write-Output ("  {0}x{0} -> {1} bytes" -f $s, $dib.Length)
}
$srcImg.Dispose()

# 3. Assemble ICO container
$total = 0
foreach ($img in $images) { $total += $img.data.Length }
$buf = [byte[]]::new(6 + $images.Count * 16 + $total)
$buf[0] = 0; $buf[1] = 0
$buf[2] = 1; $buf[3] = 0
$buf[4] = [byte]$images.Count; $buf[5] = 0
$offset = 6 + $images.Count * 16
$pos = 6
for ($i = 0; $i -lt $images.Count; $i++) {
  $img = $images[$i]
  if ($img.w -eq 256) { $buf[$pos] = 0 } else { $buf[$pos] = [byte]$img.w }
  if ($img.h -eq 256) { $buf[$pos + 1] = 0 } else { $buf[$pos + 1] = [byte]$img.h }
  $buf[$pos + 2] = 0
  $buf[$pos + 3] = 0
  [BitConverter]::GetBytes([int16]1).CopyTo($buf, $pos + 4)
  [BitConverter]::GetBytes([int16]32).CopyTo($buf, $pos + 6)
  [BitConverter]::GetBytes([uint32]$img.data.Length).CopyTo($buf, $pos + 8)
  [BitConverter]::GetBytes([uint32]$offset).CopyTo($buf, $pos + 12)
  $img.data.CopyTo($buf, $offset)
  $offset += $img.data.Length
  $pos += 16
}

# 4. Backup and overwrite the source icon
$bak = $src + '.bak'
if (-not (Test-Path $bak)) { Copy-Item $src $bak }
[IO.File]::WriteAllBytes($src, $buf)
Write-Output ("OK: {0} sizes written -> {1} (backup: {2})" -f $images.Count, $src, $bak)
