# 一次性脚本：把 1080x1922 启动图上下延展到 1080x2400（边缘行拉伸延续渐变），
# 让原生 windowBackground(center) 与 JS Splash(cover) 在主流 1080 宽屏上几何一致
Add-Type -AssemblyName System.Drawing

$targetW = 1080
$targetH = 2400
$quality = 88

$enc = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
$encParams = New-Object System.Drawing.Imaging.EncoderParameters(1)
$encParams.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, $quality)

foreach ($name in @('splash_light', 'splash_dark')) {
    $path = "d:\code\xmusic\mobile\src\assets\$name.jpg"
    $bytes = [System.IO.File]::ReadAllBytes($path)
    $ms = New-Object System.IO.MemoryStream(, $bytes)
    $src = [System.Drawing.Image]::FromStream($ms)

    if ($src.Height -ge $targetH) {
        Write-Output "$name already $($src.Width)x$($src.Height), skip"
        $src.Dispose(); $ms.Dispose()
        continue
    }

    $pad = [int](($targetH - $src.Height) / 2)
    $canvas = New-Object System.Drawing.Bitmap($targetW, $targetH)
    $g = [System.Drawing.Graphics]::FromImage($canvas)
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    # 顶部：用原图第一行像素纵向拉伸填充，延续渐变
    $g.DrawImage($src, (New-Object System.Drawing.Rectangle(0, 0, $targetW, $pad)),
        (New-Object System.Drawing.Rectangle(0, 0, $src.Width, 1)), [System.Drawing.GraphicsUnit]::Pixel)
    # 底部：用原图最后一行像素纵向拉伸填充
    $g.DrawImage($src, (New-Object System.Drawing.Rectangle(0, ($pad + $src.Height), $targetW, ($targetH - $pad - $src.Height))),
        (New-Object System.Drawing.Rectangle(0, ($src.Height - 1), $src.Width, 1)), [System.Drawing.GraphicsUnit]::Pixel)
    # 中间：原图原尺寸绘制
    $g.DrawImage($src, (New-Object System.Drawing.Rectangle(0, $pad, $src.Width, $src.Height)),
        (New-Object System.Drawing.Rectangle(0, 0, $src.Width, $src.Height)), [System.Drawing.GraphicsUnit]::Pixel)
    $g.Dispose()
    $src.Dispose()
    $ms.Dispose()

    $canvas.Save($path, $enc, $encParams)
    $canvas.Dispose()
    Write-Output "$name -> ${targetW}x${targetH} done, $((Get-Item $path).Length) bytes"
}

# 同步到原生启动窗口资源
Copy-Item d:\code\xmusic\mobile\src\assets\splash_light.jpg d:\code\xmusic\mobile\android\app\src\main\res\drawable-nodpi\splash_image.jpg -Force
Copy-Item d:\code\xmusic\mobile\src\assets\splash_dark.jpg d:\code\xmusic\mobile\android\app\src\main\res\drawable-night-nodpi\splash_image.jpg -Force
Write-Output 'native drawables synced'
