# 生成启动图：纯主题色底 + 圆角 logo 卡片 + Xmusic + 标语（明/暗两套）
# 底色与原生 windowBackground、JS 主题 t.bg 完全一致，图片边界与背景无缝，任何屏幕天然铺满
# 运行: powershell -ExecutionPolicy Bypass -File .\scripts\gen_splash.ps1
Add-Type -AssemblyName System.Drawing

$logoPath = Join-Path $PSScriptRoot '..\..\logo.jpg'
$assetsDir = Join-Path $PSScriptRoot '..\src\assets'
$resDir = Join-Path $PSScriptRoot '..\android\app\src\main\res'

# 画布 660x760 px，按 xxhdpi(3x) 投放 = 220x253 dp，与 JS 侧 Splash 固定尺寸保持一致
$W = 660
$H = 760
# 布局：logo 卡片 300x300 居中于上部，下方应用名与标语
$cardSize = 300
$cardX = ($W - $cardSize) / 2
$cardY = 100

# 标语用码点构造，规避 PowerShell 5 对无 BOM UTF-8 脚本中文字符串的乱码问题
# 让 音 乐 更 自 由（带空格模拟字间距）
$tagline = (0x8BA9, 0x97F3, 0x4E50, 0x66F4, 0x81EA, 0x7531 | ForEach-Object { [char]$_ }) -join ' '

$logo = [System.Drawing.Image]::FromFile((Resolve-Path $logoPath))

function RoundedRectPath([float]$x, [float]$y, [float]$s, [float]$r) {
    $p = New-Object System.Drawing.Drawing2D.GraphicsPath
    $d = $r * 2
    $p.AddArc($x, $y, $d, $d, 180, 90)
    $p.AddArc($x + $s - $d, $y, $d, $d, 270, 90)
    $p.AddArc($x + $s - $d, $y + $s - $d, $d, $d, 0, 90)
    $p.AddArc($x, $y + $s - $d, $d, $d, 90, 90)
    $p.CloseFigure()
    return $p
}

function Save-Jpeg($bmp, $path, [long]$quality) {
    $codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() |
        Where-Object { $_.MimeType -eq 'image/jpeg' }
    $ep = New-Object System.Drawing.Imaging.EncoderParameters(1)
    $ep.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter(
        [System.Drawing.Imaging.Encoder]::Quality, $quality)
    $dir = Split-Path $path -Parent
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir | Out-Null }
    $bmp.Save($path, $codec, $ep)
    Write-Host "saved: $path"
}

function New-Splash([string]$bgHex, [string]$textHex, [string]$subHex, [string[]]$outPaths) {
    $bg = [System.Drawing.ColorTranslator]::FromHtml($bgHex)
    $textColor = [System.Drawing.ColorTranslator]::FromHtml($textHex)
    $subColor = [System.Drawing.ColorTranslator]::FromHtml($subHex)

    $bmp = New-Object System.Drawing.Bitmap($W, $H)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
    $g.Clear($bg)

    # logo 先高质量缩放，再经 TextureBrush 填充圆角矩形获得抗锯齿边缘
    $scaled = New-Object System.Drawing.Bitmap($cardSize, $cardSize)
    $sg = [System.Drawing.Graphics]::FromImage($scaled)
    $sg.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $sg.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $sg.DrawImage($script:logo, 0, 0, $cardSize, $cardSize)
    $sg.Dispose()
    $brush = New-Object System.Drawing.TextureBrush($scaled)
    $brush.TranslateTransform($cardX, $cardY)
    $path = RoundedRectPath $cardX $cardY $cardSize ($cardSize * 0.22)
    $g.FillPath($brush, $path)
    $path.Dispose(); $brush.Dispose(); $scaled.Dispose()

    # 应用名 + 标语（水平居中）
    $fmt = New-Object System.Drawing.StringFormat
    $fmt.Alignment = [System.Drawing.StringAlignment]::Center
    $nameFont = New-Object System.Drawing.Font('Segoe UI', 84,
        [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
    $tagFont = New-Object System.Drawing.Font('Microsoft YaHei', 38,
        [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
    $textBrush = New-Object System.Drawing.SolidBrush($textColor)
    $subBrush = New-Object System.Drawing.SolidBrush($subColor)
    $g.DrawString('Xmusic', $nameFont, $textBrush,
        (New-Object System.Drawing.RectangleF(0, 455, $W, 120)), $fmt)
    $g.DrawString($tagline, $tagFont, $subBrush,
        (New-Object System.Drawing.RectangleF(0, 590, $W, 60)), $fmt)
    $nameFont.Dispose(); $tagFont.Dispose(); $textBrush.Dispose(); $subBrush.Dispose()
    $fmt.Dispose(); $g.Dispose()

    foreach ($out in $outPaths) { Save-Jpeg $bmp $out 95 }
    $bmp.Dispose()
}

# 浅色：bg #F5F7FA / text #1F2A38 / sub #8A97A8（与 src/theme LIGHT_THEME 一致）
New-Splash '#F5F7FA' '#1F2A38' '#8A97A8' @(
    (Join-Path $assetsDir 'splash_light.jpg'),
    (Join-Path $resDir 'drawable-xxhdpi\splash_image.jpg')
)
# 深色：bg #0F1B2A / text #EAF0F6 / sub #7E8CA0（与 src/theme DARK_THEME 一致）
New-Splash '#0F1B2A' '#EAF0F6' '#7E8CA0' @(
    (Join-Path $assetsDir 'splash_dark.jpg'),
    (Join-Path $resDir 'drawable-night-xxhdpi\splash_image.jpg')
)

$logo.Dispose()
Write-Host 'done.'
