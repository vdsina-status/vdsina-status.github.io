$nodePath = "c:\Users\ooolo\AppData\Local\Programs\cursor\resources\app\resources\helpers\node.exe"
$project = "C:\Users\ooolo\OneDrive\Desktop\vdsina-status"
$interval = 300 # 5 minutes

Write-Host "VDSina Status Loop — checking every $($interval/60) min" -ForegroundColor Cyan
Write-Host "Press Ctrl+C to stop`n"

while ($true) {
    $ts = Get-Date -Format "HH:mm:ss"
    Write-Host "[$ts] Running checker..." -ForegroundColor Yellow

    & $nodePath "$project\scripts\checker.mjs" 2>$null

    Set-Location $project
    git add data/ 2>$null
    $changed = $false
    git diff --cached --quiet 2>$null
    if ($LASTEXITCODE -ne 0) { $changed = $true }

    if ($changed) {
        $msg = "status: $(Get-Date -UFormat '%Y-%m-%d %H:%M') UTC"
        git commit -m $msg 2>$null | Out-Null
        git pull org main --rebase --strategy-option=ours 2>$null | Out-Null
        git push org main 2>$null | Out-Null
        Write-Host "[$ts] Pushed fresh data" -ForegroundColor Green
    } else {
        Write-Host "[$ts] No changes" -ForegroundColor Gray
    }

    Write-Host "[$ts] Next check in $($interval/60) min`n" -ForegroundColor DarkGray
    Start-Sleep -Seconds $interval
}
