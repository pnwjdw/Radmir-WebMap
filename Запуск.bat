@echo off
chcp 65001 >nul
setlocal EnableExtensions DisableDelayedExpansion
cd /d "%~dp0"
title Карта RADMIR

set "NODE="
set "CHECK=process.exit(Number(process.versions.node.split('.')[0])>=18?0:1)"

if exist "runtime\node.exe" call :usable "%CD%\runtime\node.exe" && set "NODE=%CD%\runtime\node.exe"
if not defined NODE (
  where node >nul 2>nul && call :usable node && set "NODE=node"
)
if not defined NODE (
  echo.
  echo Для работы нужен Node.js 18 или новее, а его на компьютере нет или он слишком старый.
  echo Сейчас скачаю портативный Node.js в папку runtime. Система не меняется, права администратора не нужны.
  echo.
  call "server\tools\get-node.cmd" "Пробую ещё раз..." "Через PowerShell не получилось, скачиваю через curl..." "Проверяю контрольную сумму..." "Распаковываю node.exe..." "Готово: Node.js лежит в папке runtime и используется только этой программой." "Не получилось скачать Node.js через curl."
  if exist "runtime\node.exe" call :usable "%CD%\runtime\node.exe" && set "NODE=%CD%\runtime\node.exe"
)
if not defined NODE (
  echo.
  echo Скачать Node.js автоматически не вышло. Откроется страница загрузки:
  echo поставьте версию LTS, затем снова запустите Запуск.bat.
  start "" "https://nodejs.org/ru/download"
  echo.
  pause
  exit /b 1
)

if not defined RADMIR_DECRYPTED if not exist "decrypted\" if not exist "..\decrypted\" (
  echo.
  echo Не найдена папка decrypted с файлами игры.
  echo Она должна лежать рядом с этой папкой или внутри неё. Если архив распакован не целиком,
  echo распакуйте его полностью и запустите Запуск.bat ещё раз.
  echo.
  pause
  exit /b 1
)

if not exist "resources\game-import\registry.json" (
  echo Копирую недостающие файлы из установленной игры...
  "%NODE%" "server\tools\import-game.mjs"
)

echo.
echo Запускаю сервер. Браузер откроется сам. Не закрывайте это окно, пока работаете с картой.
echo.
call :serve
if errorlevel 1 (
  echo.
  echo Сервер остановился с ошибкой, текст выше.
  pause
)
exit /b 0

:usable
for /l %%i in (1,1,5) do (
  "%~1" -e "%CHECK%" >nul 2>nul && exit /b 0
  ping -n 3 127.0.0.1 >nul
)
exit /b 1

:serve
for /l %%i in (1,1,3) do (
  "%NODE%" "server\main.js" --open
  if not errorlevel 1 exit /b 0
  if errorlevel 6 exit /b 1
  if not errorlevel 5 exit /b 1
  ping -n 3 127.0.0.1 >nul
)
exit /b 1
