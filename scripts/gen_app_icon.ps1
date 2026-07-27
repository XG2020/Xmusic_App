# 从根目录 logo.jpg 生成 Android 启动图标（5 密度 ic_launcher / ic_launcher_round）
# 运行: powershell -ExecutionPolicy Bypass -File .\scripts\gen_app_icon.ps1
Add-Type -AssemblyName System.Drawing

$src = Join-Path $PSScriptRoot '..\..\logo.jpg'
$resDir = Join-Path $PSScriptRoot '..\android\app\src\main\res'
$densities = @{
    'mipmap-mdpi'    = 48
    'mipmap-hdpi'    = 72
    'mipmap-xhdpi'   = 96
    'mipmap-xxhdpi'  = 144
    'mipmap-xxxhdpi' = 192
}

$logo = [System.Drawing.Image]::FromFile((Resolve-Path $src))

function New-ScaledBrushCanvas([int]$size) {
    # 先高质量缩放到目标尺寸，再用 TextureBrush 填充路径获得抗锯齿边缘
    $scaled = New-Object System.Drawing.Bitmap($size, $size)
    $sg = [System.Drawing.Graphics]::FromImage($scaled)
    $sg.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $sg.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $sg.DrawImage($script:logo, 0, 0, $size, $size)
    $sg.Dispose()
    $brush = New-Object System.Drawing.TextureBrush($scaled)
    $bmp = New-Object System.Drawing.Bitmap($size, $size)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.Clear([System.Drawing.Color]::Transparent)
    return $bmp, $g, $brush, $scaled
}

function RoundedRectPath([float]$s, [float]$r) {
    $p = New-Object System.Drawing.Drawing2D.GraphicsPath
    $d = $r * 2
    $p.AddArc(0, 0, $d, $d, 180, 90)
    $p.AddArc($s - $d, 0, $d, $d, 270, 90)
    $p.AddArc($s - $d, $s - $d, $d, $d, 0, 90)
    $p.AddArc(0, $s - $d, $d, $d, 90, 90)
    $p.CloseFigure()
    return $p
}

foreach ($dir in $densities.Keys) {
    $size = $densities[$dir]
    $outDir = Join-Path $resDir $dir

    # 方形图标：圆角矩形裁剪（半径约 18%，接近常见桌面图标风格）
    $bmp, $g, $brush, $scaled = New-ScaledBrushCanvas $size
    $g.FillPath($brush, (RoundedRectPath $size ($size * 0.18)))
    $g.Dispose(); $brush.Dispose(); $scaled.Dispose()
    $out = Join-Path $outDir 'ic_launcher.png'
    $bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    Write-Host "saved: $out"

    # 圆形图标：圆形裁剪
    $bmp, $g, $brush, $scaled = New-ScaledBrushCanvas $size
    $g.FillEllipse($brush, 0, 0, $size, $size)
    $g.Dispose(); $brush.Dispose(); $scaled.Dispose()
    $out = Join-Path $outDir 'ic_launcher_round.png'
    $bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    Write-Host "saved: $out"
}

$logo.Dispose()
Write-Host 'done.'
