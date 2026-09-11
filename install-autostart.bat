@echo off
chcp 65001 >nul
setlocal

set "DIR=%~dp0"
set "STARTUP=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
set "LNK=%STARTUP%\AI Hub.lnk"

echo.
echo   AI Hub - install auto-start
echo   ------------------------------------------
echo   Project : %DIR%
echo   Startup : %STARTUP%
echo.

if not exist "%DIR%start-hidden.vbs" (
  echo   [ERROR] start-hidden.vbs not found next to this script.
  pause
  exit /b 1
)

powershell -NoProfile -Command ^
  "$ws = New-Object -ComObject WScript.Shell; $sc = $ws.CreateShortcut('%LNK%'); $sc.TargetPath = '%DIR%start-hidden.vbs'; $sc.WorkingDirectory = '%DIR%'; $sc.Description = 'AI Hub background service'; $sc.Save()"

if exist "%LNK%" (
  echo   [OK] Shortcut created in Startup folder.
  echo.
  echo   The service will now start automatically after you log in.
  echo   To undo: delete "AI Hub.lnk" from the Startup folder.
) else (
  echo   [FAIL] Could not create the shortcut.
  echo   Manual way: press Win+R, type  shell:startup  and put
  echo   a shortcut of start-hidden.vbs into that folder.
)

echo.
pause
