#!/bin/bash
# One-click launcher for macOS. Double-click in Finder.
# Checks Node.js, installs dependencies on first run, then runs src/launch.js
# (free port, /health wait, opens the panel, prints the OBS URL).

cd "$(dirname "$0")" || exit 1

# Finder-launched shells can miss common Node install locations.
export PATH="/usr/local/bin:/opt/homebrew/bin:$HOME/.volta/bin:$PATH"
if ! command -v node >/dev/null 2>&1 && [ -s "$HOME/.nvm/nvm.sh" ]; then
  # shellcheck disable=SC1091
  . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1
fi

pause_and_exit() {
  echo
  read -r -n 1 -s -p "Nhấn phím bất kỳ để đóng cửa sổ này..."
  echo
  exit "${1:-1}"
}

clear
echo "================================================================"
echo "   HIỆU ỨNG QUÀ TẶNG TIKTOK LIVE"
echo "================================================================"
echo

# 1. Node.js present and recent enough?
if ! command -v node >/dev/null 2>&1; then
  echo "################################################################"
  echo "   "
  echo "   MÁY BẠN CHƯA CÓ NODE.JS — cần cài một lần duy nhất."
  echo "   "
  echo "   1. Mở trang:  https://nodejs.org"
  echo "   2. Bấm nút tải bản LTS (nút màu xanh lá)."
  echo "   3. Mở file vừa tải và bấm Tiếp tục cho đến khi xong."
  echo "   4. Bấm đúp lại file BAT-DAU này."
  echo "   "
  echo "################################################################"
  open "https://nodejs.org" >/dev/null 2>&1
  pause_and_exit 1
fi

if ! node -e "process.exit(Number(process.versions.node.split('.')[0]) >= 22 ? 0 : 1)"; then
  echo "################################################################"
  echo "   Node.js trên máy bạn đã cũ (phiên bản $(node -v))."
  echo "   Hãy tải bản mới tại:  https://nodejs.org  (bản LTS)"
  echo "   Cài xong, bấm đúp lại file BAT-DAU này."
  echo "################################################################"
  open "https://nodejs.org" >/dev/null 2>&1
  pause_and_exit 1
fi

# 2. First run: install dependencies.
if [ ! -f "node_modules/express/package.json" ] || [ ! -f "node_modules/tiktok-live-connector/package.json" ] || [ ! -f "node_modules/ws/package.json" ]; then
  echo "Lần chạy đầu tiên: đang tải các thành phần cần thiết..."
  echo "(Cần có Internet. Việc này mất khoảng 1-3 phút, chỉ làm một lần.)"
  echo
  if ! npm install --no-audit --no-fund; then
    echo
    echo "################################################################"
    echo "   KHÔNG TẢI ĐƯỢC THÀNH PHẦN CẦN THIẾT."
    echo "   Kiểm tra kết nối Internet rồi bấm đúp lại file BAT-DAU."
    echo "################################################################"
    pause_and_exit 1
  fi
  echo
  echo "Đã tải xong!"
  echo
fi

# 3-7. Free port, start, wait for /health, open browser, banner, clean shutdown.
node src/launch.js "$@"
status=$?

echo
if [ "$status" -ne 0 ]; then
  echo "Chương trình đã dừng do lỗi (mã $status). Xem thông báo phía trên."
fi
pause_and_exit "$status"
