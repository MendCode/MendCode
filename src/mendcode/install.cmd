@echo off
setlocal EnableExtensions EnableDelayedExpansion

set "APP=mendcode"
set "BASE_URL=https://github.com/MendCode/MendCode"
if defined MENDCODE_GITHUB_BASE_URL set "BASE_URL=%MENDCODE_GITHUB_BASE_URL%"

set "TARGET=%MENDCODE_WINDOWS_TARGET%"
if not defined TARGET (
  set "ARCH=%PROCESSOR_ARCHITEW6432%"
  if not defined ARCH set "ARCH=%PROCESSOR_ARCHITECTURE%"
  if /I "!ARCH!"=="AMD64" set "TARGET=windows-x64-baseline"
  if /I "!ARCH!"=="ARM64" set "TARGET=windows-arm64"
)

if not defined TARGET (
  echo Unsupported Windows architecture: %PROCESSOR_ARCHITEW6432% %PROCESSOR_ARCHITECTURE%
  exit /b 1
)

if defined MENDCODE_VERSION (
  set "DOWNLOAD_URL=!BASE_URL!/releases/download/v%MENDCODE_VERSION%/%APP%-!TARGET!.zip"
) else (
  set "DOWNLOAD_URL=!BASE_URL!/releases/latest/download/%APP%-!TARGET!.zip"
)

where.exe curl.exe >nul 2>&1
if errorlevel 1 (
  echo curl.exe is required. Download the Windows ZIP directly from:
  echo !DOWNLOAD_URL!
  exit /b 1
)

where.exe tar.exe >nul 2>&1
if errorlevel 1 (
  echo tar.exe is required to extract the release. Download the Windows ZIP directly from:
  echo !DOWNLOAD_URL!
  exit /b 1
)

set "INSTALL_DIR=%USERPROFILE%\.mendcode\bin"
set "TEMP_DIR=%TEMP%\mendcode-install-%RANDOM%-%RANDOM%"
set "ZIP_FILE=!TEMP_DIR!\%APP%-!TARGET!.zip"
mkdir "!TEMP_DIR!" >nul 2>&1
if errorlevel 1 (
  echo Could not create temporary directory: !TEMP_DIR!
  exit /b 1
)

echo Downloading MendCode (!TARGET!)...
curl.exe --fail --silent --show-error --location "!DOWNLOAD_URL!" --output "!ZIP_FILE!"
if errorlevel 1 (
  rmdir /s /q "!TEMP_DIR!" >nul 2>&1
  echo Download failed.
  exit /b 1
)

mkdir "!INSTALL_DIR!" >nul 2>&1
tar.exe -xf "!ZIP_FILE!" -C "!TEMP_DIR!"
if errorlevel 1 (
  rmdir /s /q "!TEMP_DIR!" >nul 2>&1
  echo Could not extract the MendCode ZIP.
  exit /b 1
)

set "BINARY="
for /r "!TEMP_DIR!" %%F in (mendcode.exe) do if not defined BINARY set "BINARY=%%~fF"
if not defined BINARY (
  rmdir /s /q "!TEMP_DIR!" >nul 2>&1
  echo Release asset did not contain mendcode.exe.
  exit /b 1
)

copy /y "!BINARY!" "!INSTALL_DIR!\mendcode.exe" >nul
if errorlevel 1 (
  rmdir /s /q "!TEMP_DIR!" >nul 2>&1
  echo Could not install MendCode to !INSTALL_DIR!.
  exit /b 1
)
rmdir /s /q "!TEMP_DIR!" >nul 2>&1

set "USER_PATH="
for /f "tokens=2,*" %%A in ('reg.exe query HKCU\Environment /v Path 2^>nul') do if /I "%%A"=="Path" set "USER_PATH=%%B"
if not defined USER_PATH set "USER_PATH=!INSTALL_DIR!"
echo;!USER_PATH!;| findstr.exe /I /C:";!INSTALL_DIR!;" >nul
if errorlevel 1 reg.exe add HKCU\Environment /v Path /t REG_EXPAND_SZ /d "!USER_PATH!;!INSTALL_DIR!" /f >nul
set "PATH=!INSTALL_DIR!;!PATH!"

echo.
echo MendCode is ready at !INSTALL_DIR!\mendcode.exe
"!INSTALL_DIR!\mendcode.exe" --version
echo Open a new terminal to use: mendcode
endlocal
