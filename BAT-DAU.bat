@echo off
rem One-click launcher for Windows. Double-click in Explorer.
rem Checks Node.js, installs dependencies on first run, then runs src\launch.js
rem (free port, /health wait, opens the panel, prints the OBS URL).
rem Saved as UTF-8 with CRLF line endings; chcp 65001 makes Vietnamese text render.
chcp 65001 >nul
setlocal
cd /d "%~dp0"
title Hieu ung qua tang TikTok LIVE - DUNG DONG CUA SO NAY

echo ================================================================
echo    HIỆU ỨNG QUÀ TẶNG TIKTOK LIVE
echo ================================================================
echo.

rem 1. Node.js present and recent enough?
where node >nul 2>nul
if errorlevel 1 goto :nonode
node -e "process.exit(Number(process.versions.node.split('.')[0]) >= 22 ? 0 : 1)"
if errorlevel 1 goto :oldnode

rem 2. First run: install dependencies.
if not exist "node_modules\express\package.json" goto :install
if not exist "node_modules\tiktok-live-connector\package.json" goto :install
if not exist "node_modules\ws\package.json" goto :install
goto :run

:install
echo Lần chạy đầu tiên: đang tải các thành phần cần thiết...
echo Cần có Internet. Việc này mất khoảng 1-3 phút, chỉ làm một lần.
echo.
call npm install --no-audit --no-fund
if errorlevel 1 goto :installfail
echo.
echo Đã tải xong!
echo.

:run
rem 3-7. Free port, start, wait for /health, open browser, banner, clean shutdown.
node src\launch.js %*
if errorlevel 1 (
  echo.
  echo Chương trình đã dừng do lỗi. Xem thông báo phía trên.
)
goto :end

:nonode
echo ################################################################
echo.
echo    MÁY BẠN CHƯA CÓ NODE.JS - cần cài một lần duy nhất.
echo.
echo    1. Mở trang:  https://nodejs.org
echo    2. Bấm nút tải bản LTS - nút màu xanh lá.
echo    3. Mở file vừa tải và bấm Next cho đến khi xong.
echo    4. Bấm đúp lại file BAT-DAU này.
echo.
echo ################################################################
start "" "https://nodejs.org"
goto :end

:oldnode
echo ################################################################
echo    Node.js trên máy bạn đã cũ. Hãy tải bản mới tại:
echo    https://nodejs.org  - bản LTS
echo    Cài xong, bấm đúp lại file BAT-DAU này.
echo ################################################################
start "" "https://nodejs.org"
goto :end

:installfail
echo.
echo ################################################################
echo    KHÔNG TẢI ĐƯỢC THÀNH PHẦN CẦN THIẾT.
echo    Kiểm tra kết nối Internet rồi bấm đúp lại file BAT-DAU.
echo ################################################################
goto :end

:end
echo.
echo Nhấn phím bất kỳ để đóng cửa sổ này...
pause >nul
endlocal
