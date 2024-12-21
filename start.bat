@echo off
:: Disable Quick Edit Mode
REG ADD HKEY_CURRENT_USER\Console /v QuickEdit /t REG_DWORD /d 0 /f

:: Change to the directory containing the batch file
cd /d %~dp0

:: Run the Node.js application
node main.js

:: Re-enable Quick Edit Mode (optional)
REG ADD HKEY_CURRENT_USER\Console /v QuickEdit /t REG_DWORD /d 1 /f

pause