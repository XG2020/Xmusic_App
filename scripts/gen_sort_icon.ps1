# 生成高分辨率排序图标（白色实心 + 透明底，替换过细的「⇅」文字符号）
# 运行: powershell -ExecutionPolicy Bypass -File .\scripts\gen_sort_icon.ps1
Add-Type -AssemblyName System.Drawing

$outDir = Join-Path $PSScriptRoot '..\src\assets\icons'
$size = 160
$white = [System.Drawing.Brushes]::White

$bmp = New-Object System.Drawing.Bitmap($size, $size)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.Clear([System.Drawing.Color]::Transparent)

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

# 左：向上箭头（三角头 + 圆角竖杆）
$tri = @(
    (New-Object System.Drawing.PointF(23, 62)),
    (New-Object System.Drawing.PointF(53, 22)),
    (New-Object System.Drawing.PointF(83, 62))
)
$g.FillPolygon($white, $tri)
$g.FillPath($white, (RoundedRect 44 54 18 80 8))

# 右：向下箭头（圆角竖杆 + 三角头）
$g.FillPath($white, (RoundedRect 98 26 18 80 8))
$tri = @(
    (New-Object System.Drawing.PointF(77, 98)),
    (New-Object System.Drawing.PointF(137, 98)),
    (New-Object System.Drawing.PointF(107, 138))
)
$g.FillPolygon($white, $tri)

$g.Dispose()
$path = Join-Path $outDir 'ctrl_sort.png'
$bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Host "saved: $path"
