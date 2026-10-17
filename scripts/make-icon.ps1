# Regenerates src/FluentTimer.App/Assets/FluentTimer.ico (Fluent blue rounded square with a timer glyph).
param([string]$Out = "$PSScriptRoot\..\src\FluentTimer.App\Assets\FluentTimer.ico")

Add-Type -AssemblyName System.Drawing

function New-Frame([int]$size) {
    $bmp = New-Object System.Drawing.Bitmap $size, $size
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = 'AntiAlias'
    $g.Clear([System.Drawing.Color]::Transparent)

    $r = [single]($size * 0.22)
    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $s = [single]($size - 1)
    $path.AddArc(0, 0, $r * 2, $r * 2, 180, 90)
    $path.AddArc($s - $r * 2, 0, $r * 2, $r * 2, 270, 90)
    $path.AddArc($s - $r * 2, $s - $r * 2, $r * 2, $r * 2, 0, 90)
    $path.AddArc(0, $s - $r * 2, $r * 2, $r * 2, 90, 90)
    $path.CloseFigure()
    $g.FillPath((New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 0, 120, 212))), $path)

    $white = [System.Drawing.Color]::White
    $stroke = [single][Math]::Max(1.5, $size * 0.085)
    $pen = New-Object System.Drawing.Pen $white, $stroke
    $pen.StartCap = 'Round'; $pen.EndCap = 'Round'
    $c = $size / 2.0
    $rad = $size * 0.27
    $cy = $c + $size * 0.04
    $g.DrawEllipse($pen, [single]($c - $rad), [single]($cy - $rad), [single]($rad * 2), [single]($rad * 2))
    # crown button
    $g.DrawLine($pen, [single]$c, [single]($cy - $rad - $size * 0.06), [single]$c, [single]($cy - $rad - $size * 0.12))
    # hand pointing to ~2 o'clock
    $g.DrawLine($pen, [single]$c, [single]$cy, [single]($c + $rad * 0.55), [single]($cy - $rad * 0.45))
    $g.Dispose()
    return $bmp
}

$sizes = 16, 24, 32, 48, 64, 128, 256
$pngs = foreach ($sz in $sizes) {
    $ms = New-Object System.IO.MemoryStream
    (New-Frame $sz).Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
    , $ms.ToArray()
}

$fs = [System.IO.File]::Create((Resolve-Path -LiteralPath (Split-Path $Out)).Path + '\' + (Split-Path $Out -Leaf))
$w = New-Object System.IO.BinaryWriter $fs
$w.Write([uint16]0); $w.Write([uint16]1); $w.Write([uint16]$sizes.Count)
$offset = 6 + 16 * $sizes.Count
for ($i = 0; $i -lt $sizes.Count; $i++) {
    $sz = $sizes[$i]; $dim = if ($sz -ge 256) { 0 } else { $sz }
    $w.Write([byte]$dim); $w.Write([byte]$dim); $w.Write([byte]0); $w.Write([byte]0)
    $w.Write([uint16]1); $w.Write([uint16]32)
    $w.Write([uint32]$pngs[$i].Length); $w.Write([uint32]$offset)
    $offset += $pngs[$i].Length
}
foreach ($p in $pngs) { $w.Write($p) }
$w.Close()
Write-Output "Wrote $Out"
