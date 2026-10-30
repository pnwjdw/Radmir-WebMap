@echo off
setlocal EnableExtensions DisableDelayedExpansion
set "M_RETRY=%~1"
set "M_CURL=%~2"
set "M_SUM=%~3"
set "M_UNZIP=%~4"
set "M_DONE=%~5"
set "M_FAIL=%~6"

for /l %%i in (1,1,3) do (
  if not exist "runtime\node.exe" (
    if %%i gtr 1 echo %M_RETRY%
    powershell -NoProfile -ExecutionPolicy Bypass -File "server\tools\get-node.ps1" -Root "%CD%"
  )
)
if exist "runtime\node.exe" exit /b 0

where curl >nul 2>nul || exit /b 1
where tar >nul 2>nul || exit /b 1
echo %M_CURL%
set "NV=v24.22.2"
set "NA=win-x64"
if /i "%PROCESSOR_ARCHITECTURE%"=="ARM64" set "NA=win-arm64"
if /i "%PROCESSOR_ARCHITECTURE%"=="x86" if not defined PROCESSOR_ARCHITEW6432 set "NV=v22.23.4"
if /i "%PROCESSOR_ARCHITECTURE%"=="x86" if not defined PROCESSOR_ARCHITEW6432 set "NA=win-x86"
set "NZ=node-%NV%-%NA%"
set "NT=runtime\download"
if exist "%NT%" rd /s /q "%NT%"
mkdir "%NT%" >nul 2>nul
curl -fsSL --retry 2 -o "%NT%\%NZ%.zip" "https://nodejs.org/dist/%NV%/%NZ%.zip" || goto fail
curl -fsSL --retry 2 -o "%NT%\SHASUMS256.txt" "https://nodejs.org/dist/%NV%/SHASUMS256.txt" || goto fail
echo %M_SUM%
set "TRY=0"

:sum
set /a TRY+=1
set "NH="
for /f "skip=1 delims=" %%h in ('certutil -hashfile "%NT%\%NZ%.zip" SHA256 2^>nul') do if not defined NH set "NH=%%h"
if defined NH set "NH=%NH: =%"
if defined NH findstr /i /b /c:"%NH%  %NZ%.zip" "%NT%\SHASUMS256.txt" >nul && goto unzip
if %TRY% geq 5 goto fail
ping -n 3 127.0.0.1 >nul
goto sum

:unzip
echo %M_UNZIP%
set "TRY=0"

:extract
set /a TRY+=1
if exist "%NT%\%NZ%" rd /s /q "%NT%\%NZ%" >nul 2>nul
tar -xf "%NT%\%NZ%.zip" -C "%NT%" "%NZ%/node.exe" >nul 2>nul && move /y "%NT%\%NZ%\node.exe" "runtime\node.exe" >nul 2>nul && goto done
if %TRY% geq 5 goto fail
ping -n 3 127.0.0.1 >nul
goto extract

:done
rd /s /q "%NT%" >nul 2>nul
echo %M_DONE%
exit /b 0

:fail
if exist "%NT%" rd /s /q "%NT%" >nul 2>nul
echo %M_FAIL%
exit /b 1
