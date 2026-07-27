# 生成高分辨率播放页图标（240px 白色线条/实心 + 透明底，App 内按主题 tintColor 着色）
# 覆盖：空心下载、收藏（空心/红色实心）、播放模式（列表/单曲/随机）、倍速系列、快退/快进 15 秒
# 运行: powershell -ExecutionPolicy Bypass -File .\scripts\gen_hd_icons.ps1
Add-Type -AssemblyName System.Drawing

$outDir = Join-Path $PSScriptRoot '..\src\assets\icons'
$size = 240
$strokeW = 14
$white = [System.Drawing.Color]::White

function New-Canvas {
    $bmp = New-Object System.Drawing.Bitmap($size, $size)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAlias
    $g.Clear([System.Drawing.Color]::Transparent)
    return $bmp, $g
}

function Save-Canvas($bmp, $g, $name) {
    $g.Dispose()
    $path = Join-Path $outDir $name
    $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    Write-Host "saved: $path"
}

function New-StrokePen([float]$w) {
    $pen = New-Object System.Drawing.Pen($white, $w)
    $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
    $pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
    $pen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
    return $pen
}

function RoundedRect([float]$x, [float]$y, [float]$w, [float]$h, [float]$r) {
    $p = New-Object System.Drawing.Drawing2D.GraphicsPath
    $d = $r * 2
    $p.AddArc($x, $y, $d, $d, 180, 90)
    $p.AddArc($x + $w - $d, $y, $d, $d, 270, 90)
    $p.AddArc($x + $w - $d, $y + $h - $d, $d, $d, 0, 90)
    $p.AddArc($x, $y + $h - $d, $d, $d, 90, 90)
    $p.CloseFigure()
    return $p
}

# 在圆周 angleDeg 处画顺/逆时针方向的实心箭头（dirSign: 1=顺时针, -1=逆时针）
function Draw-CircleArrow($g, [float]$cx, [float]$cy, [float]$r, [float]$angleDeg, [int]$dirSign) {
    $a = $angleDeg * [Math]::PI / 180
    $px = $cx + $r * [Math]::Cos($a)
    $py = $cy + $r * [Math]::Sin($a)
    # 屏幕坐标系（y 向下）下的切线方向
    $dx = -[Math]::Sin($a) * $dirSign
    $dy = [Math]::Cos($a) * $dirSign
    $nx = $dy
    $ny = -$dx
    $tip = New-Object System.Drawing.PointF(($px + $dx * 30), ($py + $dy * 30))
    $b1 = New-Object System.Drawing.PointF(($px - $dx * 4 + $nx * 20), ($py - $dy * 4 + $ny * 20))
    $b2 = New-Object System.Drawing.PointF(($px - $dx * 4 - $nx * 20), ($py - $dy * 4 - $ny * 20))
    $g.FillPolygon([System.Drawing.Brushes]::White, @($tip, $b1, $b2))
}

# 任意方向实心箭头（贝塞尔曲线端点用）
function Draw-ArrowHead($g, [float]$px, [float]$py, [float]$dx, [float]$dy) {
    $len = [Math]::Sqrt($dx * $dx + $dy * $dy)
    $dx = $dx / $len; $dy = $dy / $len
    $nx = $dy; $ny = -$dx
    $tip = New-Object System.Drawing.PointF(($px + $dx * 30), ($py + $dy * 30))
    $b1 = New-Object System.Drawing.PointF(($px - $dx * 4 + $nx * 20), ($py - $dy * 4 + $ny * 20))
    $b2 = New-Object System.Drawing.PointF(($px - $dx * 4 - $nx * 20), ($py - $dy * 4 - $ny * 20))
    $g.FillPolygon([System.Drawing.Brushes]::White, @($tip, $b1, $b2))
}

$sfCenter = New-Object System.Drawing.StringFormat
$sfCenter.Alignment = [System.Drawing.StringAlignment]::Center
$sfCenter.LineAlignment = [System.Drawing.StringAlignment]::Center

# ---------- 空心下载（描边：箭头 + 托盘横线） ----------
$bmp, $g = New-Canvas
$pen = New-StrokePen 16
$g.DrawLine($pen, 120, 42, 120, 150)
$arrow = @(
    (New-Object System.Drawing.PointF(76, 108)),
    (New-Object System.Drawing.PointF(120, 152)),
    (New-Object System.Drawing.PointF(164, 108))
)
$g.DrawLines($pen, $arrow)
$g.DrawLine($pen, 48, 196, 192, 196)
$pen.Dispose()
Save-Canvas $bmp $g 'download_outline.png'

# ---------- 收藏心形（路径两侧贝塞尔） ----------
function HeartPath {
    $p = New-Object System.Drawing.Drawing2D.GraphicsPath
    $p.AddBezier(120, 84, 102, 50, 56, 44, 38, 74)
    $p.AddBezier(38, 74, 22, 102, 38, 136, 120, 196)
    $p.AddBezier(120, 196, 202, 136, 218, 102, 202, 74)
    $p.AddBezier(202, 74, 184, 44, 138, 50, 120, 84)
    $p.CloseFigure()
    return $p
}

# 未收藏：白色描边空心
$bmp, $g = New-Canvas
$pen = New-StrokePen 14
$g.DrawPath($pen, (HeartPath))
$pen.Dispose()
Save-Canvas $bmp $g 'fav_off_hd.png'

# 已收藏：红色实心（取色自原 32px QQ 素材中心 #FF6666，原文件已删除故直接固定）
$red = [System.Drawing.Color]::FromArgb(255, 255, 102, 102)
$bmp, $g = New-Canvas
$redBrush = New-Object System.Drawing.SolidBrush($red)
$g.FillPath($redBrush, (HeartPath))
$redBrush.Dispose()
Save-Canvas $bmp $g 'fav_on_hd.png'

# ---------- 播放模式：列表循环（双弧箭头） ----------
function Draw-LoopArcs($g) {
    $pen = New-StrokePen 14
    $rect = New-Object System.Drawing.RectangleF(58, 58, 124, 124)
    $g.DrawArc($pen, $rect, -160, 132)
    $g.DrawArc($pen, $rect, 20, 132)
    $pen.Dispose()
    Draw-CircleArrow $g 120 120 62 -24 1
    Draw-CircleArrow $g 120 120 62 156 1
}

$bmp, $g = New-Canvas
Draw-LoopArcs $g
Save-Canvas $bmp $g 'mode_list_hd.png'

# ---------- 播放模式：单曲循环（双弧箭头 + 数字 1） ----------
$bmp, $g = New-Canvas
Draw-LoopArcs $g
$font = New-Object System.Drawing.Font('Segoe UI', 46, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
$g.DrawString('1', $font, [System.Drawing.Brushes]::White, (New-Object System.Drawing.RectangleF(0, 62, 240, 120)), $sfCenter)
$font.Dispose()
Save-Canvas $bmp $g 'mode_single_hd.png'

# ---------- 播放模式：随机（交叉双曲线，下穿线断开） ----------
$bmp, $g = New-Canvas
$pen = New-StrokePen 14
# 被穿过的线（左下 -> 右上）
$g.DrawBezier($pen, 36, 166, 100, 166, 140, 74, 188, 74)
# 沿另一条线擦出缺口
$g.CompositingMode = [System.Drawing.Drawing2D.CompositingMode]::SourceCopy
$eraser = New-Object System.Drawing.Pen([System.Drawing.Color]::Transparent, 42)
$g.DrawBezier($eraser, 36, 74, 100, 74, 140, 166, 188, 166)
$eraser.Dispose()
$g.CompositingMode = [System.Drawing.Drawing2D.CompositingMode]::SourceOver
# 上层线（左上 -> 右下）
$g.DrawBezier($pen, 36, 74, 100, 74, 140, 166, 188, 166)
$pen.Dispose()
Draw-ArrowHead $g 196 74 1 0
Draw-ArrowHead $g 196 166 1 0
Save-Canvas $bmp $g 'mode_shuffle_hd.png'

# ---------- 快退/快进 15 秒（圆弧箭头 + 15） ----------
function Draw-Seek15($g, [int]$dirSign) {
    $pen = New-StrokePen 14
    $rect = New-Object System.Drawing.RectangleF(42, 52, 156, 156)
    if ($dirSign -gt 0) {
        # 快进：顺时针，缺口在正上方，箭头在缺口右缘
        $g.DrawArc($pen, $rect, -70, 320)
        Draw-CircleArrow $g 120 130 78 -74 1
    } else {
        # 快退：逆时针，箭头在缺口左缘
        $g.DrawArc($pen, $rect, -110, -320)
        Draw-CircleArrow $g 120 130 78 -106 -1
    }
    $pen.Dispose()
    $font = New-Object System.Drawing.Font('Segoe UI', 74, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
    $g.DrawString('15', $font, [System.Drawing.Brushes]::White, (New-Object System.Drawing.RectangleF(0, 66, 240, 130)), $sfCenter)
    $font.Dispose()
}

$bmp, $g = New-Canvas
Draw-Seek15 $g -1
Save-Canvas $bmp $g 'speed_back15_hd.png'

$bmp, $g = New-Canvas
Draw-Seek15 $g 1
Save-Canvas $bmp $g 'speed_forward15_hd.png'

# ---------- 倍速系列（圆角框 + 文字） ----------
function Draw-SpeedBadge([string]$text, [string]$fontName, [float]$fontPx, [string]$file) {
    $bmp, $g = New-Canvas
    $pen = New-StrokePen 13
    $g.DrawPath($pen, (RoundedRect 26 62 188 116 26))
    $pen.Dispose()
    $font = New-Object System.Drawing.Font($fontName, $fontPx, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
    $g.DrawString($text, $font, [System.Drawing.Brushes]::White, (New-Object System.Drawing.RectangleF(26, 64, 188, 116)), $sfCenter)
    $font.Dispose()
    Save-Canvas $bmp $g $file
}

Draw-SpeedBadge '倍速' 'Microsoft YaHei' 58 'speed_normal_hd.png'
foreach ($n in @(5, 6, 7, 8, 9, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20)) {
    $label = '{0:0.0}X' -f ($n / 10)
    $file = 'speed_{0:00}_hd.png' -f $n
    Draw-SpeedBadge $label 'Segoe UI' 56 $file
}

# ---------- 删除（空心线条垃圾桶） ----------
$bmp, $g = New-Canvas
$pen = New-StrokePen 13
# 桶身（上宽下略窄的梯形折线，圆角由 Round LineJoin 提供）
$body = @(
    (New-Object System.Drawing.PointF(58, 78)),
    (New-Object System.Drawing.PointF(68, 204)),
    (New-Object System.Drawing.PointF(172, 204)),
    (New-Object System.Drawing.PointF(182, 78))
)
$g.DrawLines($pen, $body)
# 桶口横线 + 提手
$g.DrawLine($pen, 40, 78, 200, 78)
$g.DrawLine($pen, 92, 78, 92, 56)
$g.DrawLine($pen, 92, 56, 148, 56)
$g.DrawLine($pen, 148, 56, 148, 78)
# 桶身两根竖线
$g.DrawLine($pen, 100, 106, 102, 180)
$g.DrawLine($pen, 140, 106, 138, 180)
$pen.Dispose()
Save-Canvas $bmp $g 'garbage_hd.png'

# ---------- 更多（竖排三圆点，替换过细的「⋮」文字符号） ----------
$bmp, $g = New-Canvas
$dotR = 15
foreach ($cy in @(56, 120, 184)) {
    $g.FillEllipse([System.Drawing.Brushes]::White, (120 - $dotR), ($cy - $dotR), ($dotR * 2), ($dotR * 2))
}
Save-Canvas $bmp $g 'more_dots_hd.png'

Write-Host 'done.'
