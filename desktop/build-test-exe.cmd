@echo off
setlocal
pushd "%~dp0"
if errorlevel 1 exit /b 1

where node.exe >nul 2>&1
if errorlevel 1 (
  echo Node.js 22.12.0 or newer is required. Install Node.js and try again.
  goto failed
)

where npm >nul 2>&1
if errorlevel 1 (
  echo npm was not found in PATH. Reinstall Node.js or open a terminal where npm is available, then try again.
  goto failed
)

node -e "const [major,minor]=process.versions.node.split('.').map(Number); process.exit(major>22 || (major===22 && minor>=12) ? 0 : 1)"
if errorlevel 1 (
  echo Node.js 22.12.0 or newer is required. Update Node.js and try again.
  goto failed
)
for /f "delims=" %%V in ('node -p "require('./package.json').version"') do set "XMUSIC_VERSION=%%V"

set "electron_config_cache=%~dp0.electron-cache"
set "ELECTRON_BUILDER_CACHE=%~dp0.builder-cache"
set "CSC_IDENTITY_AUTO_DISCOVERY=false"

echo [1/3] Installing project dependencies...
call npm ci
if errorlevel 1 goto failed

echo [2/3] Running tests...
call npm test
if errorlevel 1 goto failed

echo [3/3] Building Windows x64 executables...
call npm run dist:win -- --publish never
if errorlevel 1 goto failed

if not exist "%~dp0release\Xmusic-%XMUSIC_VERSION%-portable.exe" (
  echo Build completed but the expected portable executable was not found.
  goto failed
)

echo.
echo Build succeeded. Run this file to test Xmusic:
echo %~dp0release\Xmusic-%XMUSIC_VERSION%-portable.exe
echo.
popd
pause
exit /b 0

:failed
echo.
echo Build failed. Keep the error above and share it for diagnosis.
echo No installer has been launched and no release has been published.
popd
pause
exit /b 1
