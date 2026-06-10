@echo off
cd /d "C:\Users\ooolo\OneDrive\Desktop\vdsina-status"
"c:\Users\ooolo\AppData\Local\Programs\cursor\resources\app\resources\helpers\node.exe" "C:\Users\ooolo\OneDrive\Desktop\vdsina-status\scripts\checker.mjs" >nul 2>&1
git add data/ >nul 2>&1
git diff --cached --quiet
if errorlevel 1 (
    git commit --trailer "Co-authored-by: Cursor <cursoragent@cursor.com>" -m "status: %date:~6,4%-%date:~3,2%-%date:~0,2% %time:~0,5% UTC" >nul 2>&1
    git pull org main --rebase --strategy-option=ours >nul 2>&1
    git push org main >nul 2>&1
)
