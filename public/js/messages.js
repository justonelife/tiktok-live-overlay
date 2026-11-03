// Friendly Vietnamese wording for every status / error the panel can show.
// Shared by the panel (browser) and unit tests (Node). Never surface raw
// server errors or JSON to the user - map a code to a sentence instead.

export const ERROR_MESSAGES = Object.freeze({
  user_offline: 'Không tìm thấy phòng live — bạn đã bật LIVE chưa?',
  room_not_found: 'Không tìm thấy phòng live — bạn đã bật LIVE chưa?',
  user_not_found: 'Không tìm thấy tên TikTok này. Hãy kiểm tra lại chính tả.',
  invalid_username: 'Tên TikTok chỉ gồm chữ cái không dấu, số, dấu chấm hoặc gạch dưới (2–24 ký tự).',
  rate_limited: 'TikTok đang tạm chặn vì kết nối quá nhiều lần. Đợi khoảng 1 phút rồi bấm “Thử lại”.',
  needs_sign_key:
    'Dịch vụ ký (Euler Stream) đang chặn ở gói miễn phí. Bấm “Thử lại” sau 1 phút; nếu vẫn vậy cần API key gói Business (có 7 ngày miễn phí) — xem mục Nâng cao.',
  timeout: 'TikTok phản hồi quá chậm. Hãy bấm “Thử lại”.',
  network: 'Không kết nối được tới TikTok. Hãy kiểm tra mạng Internet rồi bấm “Thử lại”.',
  lib_load: 'Thiếu thành phần kết nối TikTok. Hãy đóng cửa sổ đen rồi bấm đúp lại file BAT-DAU.',
  stream_ended: 'Buổi LIVE đã kết thúc.',
  disconnected: 'Đã mất kết nối với phòng live.',
  server_unreachable: 'Mất liên lạc với chương trình. Cửa sổ đen BAT-DAU còn mở không?',
  config_rejected: 'Không lưu được cài đặt này. Hãy thử lại.',
});

export const GENERIC_ERROR = 'Có lỗi khi kết nối TikTok. Hãy bấm “Thử lại” sau ít phút.';

/** Error code -> Vietnamese sentence. Unknown / missing codes -> generic message. */
export function friendlyError(code) {
  return typeof code === 'string' && Object.hasOwn(ERROR_MESSAGES, code) ? ERROR_MESSAGES[code] : GENERIC_ERROR;
}

/**
 * Describe a TikTok connection status for step 1.
 * @param {{ state?: string, username?: string|null, errorCode?: string|null }} [status]
 * @returns {{ tone: 'idle'|'busy'|'ok'|'error', text: string, canRetry: boolean, connected: boolean }}
 */
export function describeConnection(status = {}) {
  const who = status.username ? ` @${status.username}` : '';
  switch (status.state) {
    case 'connecting':
      return { tone: 'busy', text: `Đang kết nối${who}…`, canRetry: false, connected: false };
    case 'connected':
      return { tone: 'ok', text: `Đã kết nối tới phòng live!${who ? ` (${who.trim()})` : ''}`, canRetry: false, connected: true };
    case 'error':
      return { tone: 'error', text: friendlyError(status.errorCode), canRetry: true, connected: false };
    case 'ended':
      return { tone: 'error', text: friendlyError('stream_ended'), canRetry: true, connected: false };
    case 'disconnected':
      return { tone: 'error', text: friendlyError('disconnected'), canRetry: true, connected: false };
    default:
      return { tone: 'idle', text: 'Chưa kết nối. Nhập tên TikTok rồi bấm “Kết nối”.', canRetry: false, connected: false };
  }
}

/** Accepts "tên", "@tên" or a pasted profile/live link; returns the bare username or ''. */
export function cleanUsername(input) {
  let s = String(input ?? '').trim();
  const fromUrl = /tiktok\.com\/@([A-Za-z0-9._]+)/i.exec(s);
  if (fromUrl) s = fromUrl[1];
  s = s.replace(/^@+/, '');
  return /^[A-Za-z0-9._]{2,24}$/.test(s) ? s : '';
}
