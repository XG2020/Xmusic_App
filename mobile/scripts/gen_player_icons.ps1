# 生成高分辨率播放控制图标（白色实心 + 透明底，替换 32px 通知栏小图避免放大模糊）
# 运行: powershell -ExecutionPolicy Bypass -File .\scripts\gen_player_icons.ps1
Add-Type -AssemblyName System.Drawing

$outDir = Join-Path $PSScriptRoot '..\src\assets\icons'
$size = 160
$white = [System.Drawing.Brushes]::White

function New-Canvas {
    $bmp = New-Object System.Drawing.Bitmap($size, $size)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
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

# 圆角矩形路径
function RoundedRect($x, $y, $w, $h, $r) {
    $p = New-Object System.Drawing.Drawing2D.GraphicsPath
    $d = $r * 2
    $p.AddArc($x, $y, $d, $d, 180, 90)
    $p.AddArc($x + $w - $d, $y, $d, $d, 270, 90)
    $p.AddArc($x + $w - $d, $y + $h - $d, $d, $d, 0, 90)
    $p.AddArc($x, $y + $h - $d, $d, $d, 90, 90)
    $p.CloseFigure()
    return $p
}

# 播放：实心右向三角（稍向右偏保证视觉居中）
$bmp, $g = New-Canvas
$tri = @(
    (New-Object System.Drawing.PointF(48, 28)),
    (New-Object System.Drawing.PointF(140, 80)),
    (New-Object System.Drawing.PointF(48, 132))
)
$g.FillPolygon($white, $tri)
Save-Canvas $bmp $g 'ctrl_play.png'

# 暂停：两根圆角竖条
$bmp, $g = New-Canvas
$g.FillPath($white, (RoundedRect 38 28 26 104 10))
$g.FillPath($white, (RoundedRect 96 28 26 104 10))
Save-Canvas $bmp $g 'ctrl_pause.png'

# 上一曲：左侧圆角竖条 + 左向实心三角
$bmp, $g = New-Canvas
$g.FillPath($white, (RoundedRect 26 32 18 96 8))
$tri = @(
    (New-Object System.Drawing.PointF(52, 80)),
    (New-Object System.Drawing.PointF(134, 32)),
    (New-Object System.Drawing.PointF(134, 128))
)
$g.FillPolygon($white, $tri)
Save-Canvas $bmp $g 'ctrl_prev.png'

# 下一曲：右向实心三角 + 右侧圆角竖条
$bmp, $g = New-Canvas
$tri = @(
    (New-Object System.Drawing.PointF(26, 32)),
    (New-Object System.Drawing.PointF(108, 80)),
    (New-Object System.Drawing.PointF(26, 128))
)
$g.FillPolygon($white, $tri)
$g.FillPath($white, (RoundedRect 116 32 18 96 8))
Save-Canvas $bmp $g 'ctrl_next.png'
