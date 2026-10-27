# Bundled into native.ts at build time (file:// import) and run from a copy in Vencord's data folder. Keep it ASCII-only.
# Windows PowerShell 5.1 writes redirected stdout in the console's OEM code page; force UTF-8 so
# non-ASCII titles (Japanese, Cyrillic, emoji, ...) reach Node intact.
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false } catch { }
$ErrorActionPreference = 'Stop'
try {
    Add-Type -AssemblyName System.Runtime.WindowsRuntime | Out-Null
    $asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
        $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
    })[0]
    function Await($op, $type) {
        $task = $asTaskGeneric.MakeGenericMethod($type).Invoke($null, @($op))
        $task.Wait(-1) | Out-Null
        return $task.Result
    }
    [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime] | Out-Null
    [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties, Windows.Media.Control, ContentType = WindowsRuntime] | Out-Null
    $mgr = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
    $session = $mgr.GetCurrentSession()
    if ($null -eq $session) { Write-Output '{"ok":false,"reason":"no-session"}'; exit }
    $props = Await ($session.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
    $timeline = $session.GetTimelineProperties()
    $playback = $session.GetPlaybackInfo()
    $out = @{
        ok = $true
        title = "$($props.Title)"
        artist = "$($props.Artist)"
        album = "$($props.AlbumTitle)"
        isPlaying = ($playback.PlaybackStatus -eq 4)
        position = [int64]$timeline.Position.TotalMilliseconds
        duration = [int64]$timeline.EndTime.TotalMilliseconds
        appId = "$($session.SourceAppUserModelId)"
    }
    $out | ConvertTo-Json -Compress
} catch {
    # ConvertTo-Json escapes quotes, backslashes and newlines in the message (hand-built JSON didn't).
    @{ ok = $false; error = "$($_.Exception.Message)" } | ConvertTo-Json -Compress
}
