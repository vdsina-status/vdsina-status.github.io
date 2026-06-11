@echo off
setlocal EnableDelayedExpansion
cd /d "C:\Users\ooolo\OneDrive\Desktop\vdsina-status"
set NODE=c:\Users\ooolo\AppData\Local\Programs\cursor\resources\app\resources\helpers\node.exe
set LOG=logs\run-check.log
if not exist logs mkdir logs

>>"%LOG%" echo.
>>"%LOG%" echo === START %DATE% %TIME% ===

git fetch org main >>"%LOG%" 2>&1
if errorlevel 1 (>>"%LOG%" echo FETCH FAILED & exit /b 1)

git checkout org/main -- data/ >>"%LOG%" 2>&1
if errorlevel 1 (>>"%LOG%" echo CHECKOUT data FAILED & exit /b 1)

>>"%LOG%" echo running checker...
"%NODE%" scripts\checker.mjs >>"%LOG%" 2>&1
if errorlevel 1 (>>"%LOG%" echo CHECKER FAILED & exit /b 1)

git add data/ >>"%LOG%" 2>&1
git diff --cached --quiet
if errorlevel 1 (
    git commit -m "status: %DATE:~6,4%-%DATE:~3,2%-%DATE:~0,2% %TIME:~0,2%:%TIME:~3,2% UTC" >>"%LOG%" 2>&1
    git pull org main --rebase >>"%LOG%" 2>&1
    git push org main >>"%LOG%" 2>&1
    if errorlevel 1 (>>"%LOG%" echo PUSH FAILED & exit /b 1)
    >>"%LOG%" echo PUSH OK
) else (
    >>"%LOG%" echo NO CHANGES
)

>>"%LOG%" echo === DONE ===
endlocal
