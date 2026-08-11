Add-Type -AssemblyName System.Drawing

$careviewRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$iconTargets = @(
    @{ Size = 180; Name = "apple-touch-icon.png" },
    @{ Size = 192; Name = "icon-192.png" },
    @{ Size = 512; Name = "icon-512.png" }
)

foreach ($iconTarget in $iconTargets) {
    $iconSize = [int]$iconTarget.Size
    $iconPath = Join-Path $careviewRoot $iconTarget.Name
    $iconBitmap = [System.Drawing.Bitmap]::new($iconSize, $iconSize)
    $iconGraphics = [System.Drawing.Graphics]::FromImage($iconBitmap)

    try {
        $iconGraphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
        $iconGraphics.Clear([System.Drawing.ColorTranslator]::FromHtml("#164f43"))

        $shieldBrush = [System.Drawing.SolidBrush]::new([System.Drawing.ColorTranslator]::FromHtml("#dff3e9"))
        $shieldPoints = [System.Drawing.PointF[]]@(
            [System.Drawing.PointF]::new($iconSize * 0.50, $iconSize * 0.14),
            [System.Drawing.PointF]::new($iconSize * 0.78, $iconSize * 0.24),
            [System.Drawing.PointF]::new($iconSize * 0.78, $iconSize * 0.46),
            [System.Drawing.PointF]::new($iconSize * 0.73, $iconSize * 0.62),
            [System.Drawing.PointF]::new($iconSize * 0.62, $iconSize * 0.74),
            [System.Drawing.PointF]::new($iconSize * 0.50, $iconSize * 0.82),
            [System.Drawing.PointF]::new($iconSize * 0.38, $iconSize * 0.74),
            [System.Drawing.PointF]::new($iconSize * 0.27, $iconSize * 0.62),
            [System.Drawing.PointF]::new($iconSize * 0.22, $iconSize * 0.46),
            [System.Drawing.PointF]::new($iconSize * 0.22, $iconSize * 0.24)
        )
        $iconGraphics.FillPolygon($shieldBrush, $shieldPoints)

        $checkPen = [System.Drawing.Pen]::new([System.Drawing.ColorTranslator]::FromHtml("#164f43"), $iconSize * 0.065)
        $checkPen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
        $checkPen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
        $checkPen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
        $checkPoints = [System.Drawing.PointF[]]@(
            [System.Drawing.PointF]::new($iconSize * 0.36, $iconSize * 0.49),
            [System.Drawing.PointF]::new($iconSize * 0.46, $iconSize * 0.59),
            [System.Drawing.PointF]::new($iconSize * 0.66, $iconSize * 0.38)
        )
        $iconGraphics.DrawLines($checkPen, $checkPoints)

        $iconBitmap.Save($iconPath, [System.Drawing.Imaging.ImageFormat]::Png)
    }
    finally {
        if ($null -ne $checkPen) { $checkPen.Dispose() }
        if ($null -ne $shieldBrush) { $shieldBrush.Dispose() }
        $iconGraphics.Dispose()
        $iconBitmap.Dispose()
    }
}
