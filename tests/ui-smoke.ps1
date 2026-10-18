<#
UI smoke test for the floating widget. Runs the app with an isolated data folder (never touches real data or
Windows startup), re-applies settings like dropping the widget does, then checks that:
  1. the app is still running and logged no error,
  2. the widget window exists and its pill is drawn (pixels differ from the desktop behind it),
  3. its transparent headroom really is transparent (it shows the test's own magenta backdrop behind it).
Exit code 0 = pass, 1 = fail. If no desktop is available to capture, it reports SKIP and exits 0.

Usage: pwsh tests/ui-smoke.ps1 -Exe publish/FluentTimer.exe
#>
param([Parameter(Mandatory)] [string]$Exe, [string]$Artifacts = (Join-Path ([IO.Path]::GetTempPath()) 'FluentTimerSmokeArtifacts'))

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing, System.Windows.Forms
Add-Type @"
using System; using System.Runtime.InteropServices; using System.Text;
public static class Smoke {
  [StructLayout(LayoutKind.Sequential)] public struct R { public int L, T, Rt, B; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out R r);
  public delegate bool EP(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EP cb, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
}
"@

function Capture([System.Drawing.Rectangle]$r) {
    $bmp = New-Object System.Drawing.Bitmap $r.Width, $r.Height
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.CopyFromScreen($r.Left, $r.Top, 0, 0, $bmp.Size)
    $g.Dispose()
    return $bmp
}

function Fail($msg) {
    Write-Host "FAIL: $msg"
    # Save what the widget area looked like before and after, to see why.
    if ($script:after) {
        New-Item -ItemType Directory -Force $Artifacts | Out-Null
        $script:after.Save((Join-Path $Artifacts 'widget.png'))
        Write-Host "saved the widget capture to $Artifacts"
    }
    exit 1
}

$exePath = (Resolve-Path $Exe).Path
$data = Join-Path ([IO.Path]::GetTempPath()) "FluentTimerSmoke_$([guid]::NewGuid().ToString('N'))"
New-Item -ItemType Directory -Force $data | Out-Null

# A running timer so the widget shows its full pill; placed mid-screen (not snapped, horizontal).
$work = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
$left = $work.Left + [int]($work.Width / 2); $top = $work.Top + [int]($work.Height / 2)
@{ FirstRunDone = $true; Pill = @{ Left = $left; Top = $top; FadeWhenAway = $false } } | ConvertTo-Json -Depth 4 |
    Set-Content (Join-Path $data 'settings.json') -Encoding ascii
$now = [DateTime]::UtcNow
@{ Timers = @(@{ Id = [guid]::NewGuid(); Label = 'Smoke'; Kind = 'Countdown'; State = 'Running'; Duration = '00:10:00';
        InitialDuration = '00:10:00'; EndsAtUtc = $now.AddMinutes(10).ToString('o'); StartedAtUtc = $now.ToString('o') });
    Reminders = @(); Alarms = @() } | ConvertTo-Json -Depth 5 | Set-Content (Join-Path $data 'state.json') -Encoding utf8

try {
    $virtual = [System.Windows.Forms.SystemInformation]::VirtualScreen
    (Capture $virtual).Dispose() # can we capture the desktop at all?
} catch {
    Write-Host "SKIP: no desktop available to capture ($($_.Exception.Message))"; exit 0
}

# A solid magenta backdrop behind where the widget will appear, so the test doesn't depend on whatever else is
# on screen (a busy desktop changes under the widget). The widget is topmost and created later, so it sits above.
$key = [System.Drawing.Color]::FromArgb(255, 0, 255)
$backdrop = New-Object System.Windows.Forms.Form -Property @{
    FormBorderStyle = 'None'; ShowInTaskbar = $false; TopMost = $true; StartPosition = 'Manual'; BackColor = $key
    Bounds = New-Object System.Drawing.Rectangle ($left - 160), ($top - 120), 720, 360
}
$backdrop.Show()
[System.Windows.Forms.Application]::DoEvents()

$env:FLUENTTIMER_DEV = '1'; $env:FLUENTTIMER_DATA = $data; $env:FLUENTTIMER_SELFTEST = 'reapply'
$p = Start-Process -PassThru $exePath -ArgumentList '--minimized'
try {
    Start-Sleep 7   # startup + the 3 s re-apply + settle
    if ($p.HasExited) { Fail "app exited with code $($p.ExitCode)" }
    $err = Join-Path $data 'error.log'
    if (Test-Path $err) { Fail "error.log written:`n$(Get-Content $err -Raw)" }

    $script:rect = $null
    [Smoke]::EnumWindows({ param($h, $l)
        $pp = 0; [void][Smoke]::GetWindowThreadProcessId($h, [ref]$pp)
        $sb = New-Object Text.StringBuilder 128; [void][Smoke]::GetWindowText($h, $sb, 128)
        if ($pp -eq $p.Id -and $sb.ToString() -eq 'Fluent Timer widget') { $r = New-Object Smoke+R; [void][Smoke]::GetWindowRect($h, [ref]$r); $script:rect = $r }
        $true }, [IntPtr]::Zero) | Out-Null
    if ($null -eq $script:rect) { Fail 'widget window not found' }
    $r = $script:rect
    $w = $r.Rt - $r.L; $h = $r.B - $r.T
    Write-Host "widget window at $($r.L),$($r.T) size ${w}x$h"

    $area = New-Object System.Drawing.Rectangle $r.L, $r.T, $w, $h
    $b = $backdrop.Bounds
    if (-not $b.Contains($area)) { Fail "widget ($area) is not over the test backdrop ($b)" }
    $script:after = Capture $area
    $after = $script:after
    # "Same" = the pixel shows the magenta backdrop, i.e. the widget is transparent there.
    function Same([int]$x, [int]$y) {
        $c = $after.GetPixel($x, $y)
        $diff = [Math]::Abs([int]$c.R - $key.R) + [Math]::Abs([int]$c.G - $key.G) + [Math]::Abs([int]$c.B - $key.B)
        return $diff -le 12
    }

    # Headroom: the window's corners and edge midpoints are transparent margin.
    $xs = 3, ($w - 4), 3, ($w - 4), [int]($w / 2), [int]($w / 2)
    $ys = 3, 3, ($h - 4), ($h - 4), 3, ($h - 4)
    $bad = 0
    for ($i = 0; $i -lt $xs.Count; $i++) { if (-not (Same $xs[$i] $ys[$i])) { $bad++ } }
    if ($bad -gt 0) { Fail "transparent headroom is painted at $bad/$($xs.Count) probes" }

    # Pill: something must be drawn in the middle of the window.
    $drawn = 0
    for ($x = [int]($w * 0.35); $x -le [int]($w * 0.65); $x += 4) { if (-not (Same $x ([int]($h / 2)))) { $drawn++ } }
    if ($drawn -lt 3) { Fail 'pill does not appear to be drawn' }

    Write-Host "PASS: widget transparent after settings re-apply; pill drawn ($drawn changed probes)"
    exit 0
}
finally {
    if (-not $p.HasExited) { $p | Stop-Process -Force }
    $backdrop.Close()
    foreach ($v in 'FLUENTTIMER_DEV', 'FLUENTTIMER_DATA', 'FLUENTTIMER_SELFTEST') { Remove-Item "Env:$v" -ErrorAction SilentlyContinue }
}
