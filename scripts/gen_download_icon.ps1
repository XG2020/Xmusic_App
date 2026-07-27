# 生成实心下载图标：白色形状 + 透明底（App 内按主题色 tint 着色）
Add-Type -AssemblyName System.Drawing

$size = 120
$bmp = New-Object System.Drawing.Bitmap($size, $size)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.Clear([System.Drawing.Color]::Transparent)

$white = [System.Drawing.Brushes]::White

# 箭头杆（圆角矩形近似：矩形 + 顶部圆帽）
$stemW = 26
$stemX = ($size - $stemW) / 2
$g.FillRectangle($white, $stemX, 14, $stemW, 46)
$g.FillEllipse($white, $stemX, 6, $stemW, 16)

# 箭头三角
$pts = @(
  (New-Object System.Drawing.PointF(22, 56)),
  (New-Object System.Drawing.PointF(98, 56)),
  (New-Object System.Drawing.PointF(60, 94))
)
$g.FillPolygon($white, $pts)

# 底部托盘横条（圆角）
$trayPath = New-Object System.Drawing.Drawing2D.GraphicsPath
$trayRect = New-Object System.Drawing.RectangleF(14, 102, 92, 14)
$r = 7
$trayPath.AddArc($trayRect.X, $trayRect.Y, $r * 2, $r * 2, 180, 90)
$trayPath.AddArc($trayRect.Right - $r * 2, $trayRect.Y, $r * 2, $r * 2, 270, 90)
$trayPath.AddArc($trayRect.Right - $r * 2, $trayRect.Bottom - $r * 2, $r * 2, $r * 2, 0, 90)
$trayPath.AddArc($trayRect.X, $trayRect.Bottom - $r * 2, $r * 2, $r * 2, 90, 90)
$trayPath.CloseFigure()
$g.FillPath($white, $trayPath)

$g.Dispose()
$out = Join-Path $PSScriptRoot '..\src\assets\icons\download_filled.png'
$bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Host "saved: $out"
