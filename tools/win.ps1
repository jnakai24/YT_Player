# YT Player のウィンドウを操作して状態を表示する（動作確認用）。
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\win.ps1                 # 状態だけ
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\win.ps1 minimize        # プレイヤー画面を最小化
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\win.ps1 maximize mini   # ミニプレイヤーを最大化
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\win.ps1 close mini      # ミニプレイヤーの ×
# 表示例: main[vis=True,max=False,min=False] mini[vis=False,max=False,min=False]
# 実際のユーザー操作と同じく WM_SYSCOMMAND / WM_CLOSE を送る。タイトルは ytplayer.py の VERSION から作る。
param([string]$Action = 'status', [string]$Target = 'main')

$ver = (Select-String -Path (Join-Path $PSScriptRoot '..\ytplayer.py') -Pattern '^VERSION = "(.+?)"').Matches[0].Groups[1].Value
$titles = @{ main = "YT Player v$ver"; mini = "YT Player mini v$ver" }

Add-Type @'
using System; using System.Runtime.InteropServices;
public class YtpWin {
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr FindWindow(string c, string t);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr h, int m, IntPtr w, IntPtr l);
}
'@
# PowerShell は $null を "" にして渡すので、FindWindow のクラス名には NullString を使う
$n = [NullString]::Value
$h = [YtpWin]::FindWindow($n, $titles[$Target])

switch ($Action) {
    'close'    { [YtpWin]::SendMessage($h, 0x10, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null; Start-Sleep 3 }
    'minimize' { [YtpWin]::SendMessage($h, 0x112, [IntPtr]0xF020, [IntPtr]::Zero) | Out-Null; Start-Sleep 2 }
    'maximize' { [YtpWin]::SendMessage($h, 0x112, [IntPtr]0xF030, [IntPtr]::Zero) | Out-Null; Start-Sleep 2 }
    'restore'  { [YtpWin]::SendMessage($h, 0x112, [IntPtr]0xF120, [IntPtr]::Zero) | Out-Null; Start-Sleep 2 }
}

function State($t) {
    $w = [YtpWin]::FindWindow($n, $t)
    if ($w -eq 0) { 'none' } else { "vis=$([YtpWin]::IsWindowVisible($w)),max=$([YtpWin]::IsZoomed($w)),min=$([YtpWin]::IsIconic($w))" }
}
"main[$(State $titles.main)] mini[$(State $titles.mini)]"
