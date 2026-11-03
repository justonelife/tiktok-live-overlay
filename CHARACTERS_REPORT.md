# Báo cáo: hệ thống nhân vật pixel retro

Ngày chạy verify: 2026-11-03, macOS (Darwin 24.6), Node v24.14.0, Google Chrome (CDP). Chưa commit.

## 1. Tóm tắt

Mỗi người xem có một nhân vật pixel 16×16 sinh bằng code, ngoại hình cố định theo `user.id`. Nhân vật đi lại trong một dải sân khấu canvas phía trên ticker, phản ứng với gift / comment / like / follow / join / share và tương tác với nhau: chào nhau, hưởng ứng gift, gật đầu khi có người nói, toả tim / sao, đội vương miện theo top, thỉnh thoảng cả nhóm nhảy chung. Không dùng asset ngoài, không thêm package npm, chỉ dùng Canvas 2D thuần.

| Kiểm tra | Kết quả thật |
| --- | --- |
| `npm test` | **95 test: 95 pass, 0 fail** (70 test cũ không đổi + 25 test mới trong `test/characters.test.js`), 3 lần chạy liên tiếp ở bản 94 test và mọi lần chạy sau khi sửa review đều xanh |
| `HEADFUL=1 node scripts/shots-characters.js` | **44/44 check pass, 0 console error** |
| `node scripts/shots-characters.js` (headless) | **43/43 check pass, 0 console error** (FPS chỉ ghi nhận, không chấm; xem mục 6) |
| `node scripts/screenshots.js` (script cũ) | 52/52 pass, 0 console error, **sau khi hạ một ngưỡng** (mục 8) |
| `node scripts/shots-beginner.js` (script cũ) | 28/28 pass, 0 console error |
| FPS với 12 nhân vật (Chrome có cửa sổ, đặt ngoài màn hình) | **60,1 fps** đo trong 3,01 s; chi phí update + draw **0,69 ms/frame** |

## 2. File

Mới:
- `public/js/characters-sprite.js`: hash → seed → ngoại hình, sinh grid pixel cho từng pose, palette, icon (tim / sao / vương miện / tia sáng / khói).
- `public/js/characters.js`: `Character` (state machine), `CharacterWorld` (spawn, cap, LRU, tách nhau, timer, particle pool) và `CharacterLayer` (canvas, một vòng rAF, config, theme, resize).
- `public/js/characters-interact.js`: luật tương tác.
- `public/js/characters-render.js`: renderer Canvas 2D (cache sprite, bóng, vương miện, tên, bong bóng chat, particle).
- `test/characters.test.js`: 25 test.
- `scripts/shots-characters.js`: verify bằng CDP (npm: `shots:characters`).

Sửa:
- `src/config.js`: khoá `characters` và hàm `applyConfigPatch` để merge.
- `src/settings.js`: merge `characters` khi đọc file.
- `src/server.js`: `POST /api/characters/spawn`; mock gọi `greet(8)` khi boot.
- `src/mock.js`: thêm `greet()`, `viewers()`, helper `#later`.
- `public/overlay.html`: thêm `<canvas>`.
- `public/js/overlay.js`: nối event / config / leaderboard, `pagehide`, hook debug.
- `public/css/overlay.css`: band sân khấu + z-index.
- `public/panel.html`, `public/js/panel.js`, `public/css/panel.css`: mục "Nhân vật pixel".
- `README.md`, `package.json` (chỉ thêm script npm, không thêm dependency).
- `scripts/screenshots.js`: chỉ đổi một ngưỡng (mục 8).

## 3. Kiến trúc sprite: hash ra ngoại hình thế nào

1. `hashString(user.id)` dùng FNV-1a 32-bit trên các UTF-16 code unit, trả về `seed`.
2. `mulberry32(seed)` là PRNG tất định. Các giá trị lấy ra theo thứ tự cố định:
   - **thân**: 1 trong 4 archetype 16×16: `classic`, `stocky` (vai rộng), `tall` (đầu nhỏ, chân dài), `chibi` (đầu 10×8)
   - **da**: 6 tông
   - **kiểu tóc**: 6 kiểu (`short`, `spiky`, `long`, `bangs`, `bun`, `mohawk`)
   - **màu tóc**: 10 màu
   - **áo**: 10 màu
   - **quần**: 6 màu
   - **giày**: 4 màu
   - **phụ kiện**: 5 loại (`cap` = mũ lưỡi trai, `nonla` = nón lá, `headphones` = tai nghe, `glasses` = kính râm, `catears` = tai mèo)
   - **màu phụ kiện**: 8 màu
   - **má hồng** (45%)
   - **làn sâu** ưa thích và **tốc độ đi**

   Không có `Math.random` trong phần ngoại hình. Test: 400 id cho ≥ 390 bộ trang phục khác nhau, và cả 4 thân / 6 tóc / 5 phụ kiện đều xuất hiện.
3. `spriteGrid(look, pose)` vẽ lên lưới 18×20 các slot palette (0 = trong suốt), thân 16×16 đặt tại (1,3). Thứ tự vẽ: chân → tóc sau → thân áo → đầu → mặt → tóc trước → phụ kiện → tay. Cuối cùng một pass tự thêm viền 1 px (slot `outline`) quanh mọi vùng đã tô. Có 14 pose: `idleA/B`, `blink`, `walkA/M/B`, `waveA/B`, `danceA/B`, `cheer`, `talkA/B`, `heart`. Hai pose thở và đi bộ dịch nửa trên xuống 1 px nhưng giữ chân đứng yên.
4. `paletteFor(look, outline)` đổi slot thành màu. **Màu viền lấy từ theme** (`--panel-bg-2`).
5. Renderer tô grid một lần lên canvas 1x tách rời (`OffscreenCanvas`, không gắn vào DOM), cache theo `id|pose`, rồi `drawImage` phóng to với `imageSmoothingEnabled = false`. Cỡ một pixel sprite là số nguyên pixel thiết bị: `round(scale × min(rộng, cao_band × 1,5) / 360 × dpr)`. Scale 3 ở 1080 px rộng cho 9 px, tức thân cao 144 px. Nhân vật quay trái được lật bằng `setTransform(-1, …)` quanh toạ độ nguyên nên vẫn sắc nét.

## 4. State machine

| State | Vào khi | Ra khi | Hình |
| --- | --- | --- | --- |
| `enter` | spawn (join, hoặc tương tác đầu tiên) | sau 0,75 s → `idle`, rồi chạy phản ứng đã hoãn (nếu có) | rơi từ trên xuống, nảy nhẹ, giơ tay |
| `idle` | hết state khác | hết 1,2–4 s: 55% → `walk`, 45% → `idle` | thở (nhấp 1 px), nháy mắt |
| `walk` | từ `idle` | tới đích hoặc quá 8 s → `idle` | 4 frame chân, quay mặt theo chiều đi; đích là chỗ ít người nhất trong 3 điểm ngẫu nhiên |
| `wave` | join, share, chào nhau, hưởng ứng gift / join | 1,6 s → `idle` | vẫy tay phải 2 frame |
| `dance` | gift < 100 kim cương, combo đang chạy, nhảy tập thể | 2,4 s (nhảy tập thể 2,2 s) | tay trái / phải luân phiên, nhún |
| `celebrate` | gift ≥ 100 kim cương | 3,4 s | hai tay giơ, nhảy cao, toả tia sáng |
| `talk` | comment (kèm bong bóng); gật đầu `nod` khi người gần đó nói (0,9 s, không bong bóng) | 2,6 s / 0,9 s | miệng mở / đóng; `nod` là nhấp đầu |
| `heart` | like, hưởng ứng | 1,4 s | tay đưa ra, tim pixel bay lên |
| `star` | follow, hưởng ứng | 1,6 s | giơ tay, bật nhảy, sao pixel |
| `leave` | bị đẩy ra (LRU) | 0,5 s → xoá | bay lên, mờ dần, thu nhỏ, khói pixel |

Quy tắc phản ứng (`Character.react`), **không có hàng đợi**:
- Đang `enter`: chỉ giữ **một** phản ứng hoãn, cái có ưu tiên cao nhất.
- Ưu tiên: `heart` = `nod` 1 < `wave` = `star` 2 < `talk` 3 < `dance` 4 < `celebrate` 5. Phản ứng thấp hơn bị bỏ khi phản ứng cao hơn còn chạy hơn 0,25 s.
- Cùng ưu tiên: giữ cái nào kết thúc muộn hơn ("extended").
- Cooldown riêng cho từng loại trên từng nhân vật: tim 1,2 s, `nod` 2,5 s, vẫy 2,5 s, sao 2 s, nói 0,6 s, nhảy 0,8 s, ăn mừng 1,5 s.
- Đang `leave` thì mọi phản ứng bị bỏ. Nếu người đó tương tác lại, nhân vật được **revive** chứ không tạo bản sao.

## 5. Bảng tương tác

| Sự kiện / tình huống | Người gây ra | Nhân vật gần đó |
| --- | --- | --- |
| `join` | rơi vào sân khấu rồi `wave` | 1 nhân vật gần nhất (≤ 4 thân) quay sang `wave` chào lại sau 0,8 s |
| Hai nhân vật đi gần nhau | — | Kiểm tra mỗi 0,6 s: cặp rảnh, cách ≤ 2,6 thân, cùng độ sâu, xác suất 12%. Cả hai `wave`, **quay mặt vào nhau**, bong bóng "Chào!/Hi!/Hế lô!…". Cooldown 9 s mỗi nhân vật |
| `gift` | `dance` (< 100 kim cương) hoặc `celebrate` (≥ 100, kèm tia sáng) | Tối đa 4 người gần (≤ 4 thân, gift lớn ≤ 6 thân) quay mặt về người tặng, so le 0,15–0,6 s, luân phiên `wave` / `heart` |
| `combo` (streak đang chạy) | tiếp tục `dance` (cooldown chống spam) | — |
| `comment` | `talk` + bong bóng chat pixel (cắt 26 ký tự + "…", hiện 4 s, tối đa 3 bong bóng cùng lúc) | Tối đa 2 người gần **gật đầu** (`talk` ngắn) quay về phía người nói |
| `like` | `heart` + tim pixel bay | Tối đa 2 người gần, mỗi người xác suất 60%, cùng toả tim |
| `follow` | `star` + sao pixel | Tối đa 2 người gần toả sao |
| `share` | `wave` | — |
| Leaderboard | Ai nằm trong top N đội **vương miện pixel** theo màu hạng (`--rank-1/2/3`, từ hạng 4 dùng `--accent`). Cập nhật mỗi lần leaderboard đổi và khi mở lại trang (`hello`) | |
| Nhảy tập thể | Mỗi 25–40 s (thời gian sân khấu): mọi nhân vật không đang enter / leave / celebrate nhảy **cùng nhịp** (2 nhịp/s, 2,2 s), kèm tia sáng. Tắt bằng `characters.groupDance` | |

## 6. Hiệu năng: số đo thật và cách hiểu

| Môi trường | rAF trần (trang trống) | Vòng nhân vật với 12 nhân vật | update + draw |
| --- | --- | --- | --- |
| Chrome có cửa sổ, đặt ngoài màn hình (`HEADFUL=1`) | 47,3 fps | **60,1 fps** trong 3,01 s | **0,69 ms/frame** (EMA) |
| Chrome headless (`--headless=new`) | 16,1 fps | 11,6 fps | 2,23 ms/frame |

- **Headless Chrome trên máy này tự giới hạn rAF khoảng 15–17 fps, kể cả với `about:blank` ở 400×400.** Tôi đã thử `--disable-renderer-backgrounding`, `--disable-background-timer-throttling`, `--use-angle=metal`, `--headless=old`, `bringToFront` và focus emulation; không cách nào vượt 18 fps. Vì vậy headless chỉ dùng để chụp ảnh và kiểm tra logic. FPS được chấm ở lần chạy `HEADFUL=1`. Ở headless, overlay đạt 72% so với rAF trần, nhưng tôi **chưa tách** phần sụt đó ra giữa nhân vật và các lớp DOM cũ (particles, banner).
- rAF trần có cửa sổ đo được 47,3 fps trong khi trang overlay đạt 60,1. Số trần được đo ở tab mới ngay khi Chrome vừa khởi động (chưa "ấm"), nên nó chỉ là mốc tham khảo, không phải trần thật.
- Benchmark throughput (600 bước update + draw liên tục, ép flush bằng `getImageData` một lần ở cuối): 0,062 ms/frame. **Đừng hiểu con số này là "16 000 fps"**: GPU raster chạy song song và chỉ flush một lần. Số đáng tin là FPS đo được và 0,69 ms/frame.
- DOM: 53 → 53 node ngoài `#particles` sau 3 s, chỉ có 1 `<canvas>`. Không tạo DOM node nào mỗi frame.
- Giới hạn: tối đa 48 particle hiệu ứng (pool tái sử dụng), 3 bong bóng, 64 timer tương tác. Cache sprite được dọn mỗi 240 frame.
- Một vòng `requestAnimationFrame` duy nhất, tính theo delta time (kẹp tối đa 0,1 s). Vòng bị `cancelAnimationFrame` khi `pagehide` hoặc khi tắt nhân vật. Nếu một frame lỗi thì vòng không chết (log thưa, có đếm lỗi). Kết quả đo: 0 lỗi.

## 7. Verify đã chạy (lệnh thật)

1. `npm test`: 95/95 pass. Các test mới gồm:
   - hash ra cùng nhân vật (ngoại hình và mọi frame)
   - mọi pose có viền kín và chân chạm `FEET_ROW`
   - cap: fuzz 3000 bước ngẫu nhiên, kiểm tra cap sau **mỗi** event và **mỗi** update
   - LRU kèm animation rời đi; hạ `max` có hiệu lực ngay; revive
   - priority, cooldown và chuyển state
   - từng luật tương tác, chào nhau, nhảy tập thể (bật / tắt), vương miện
   - validate và merge config (server và file settings)
   - endpoint spawn (WS nhận đúng các join, đếm 0 / 21 / -1 / 2,5 / "3" / null đều trả 400)
   - markup của panel và overlay
   - không asset ngoài, không thêm package
   - các lỗi reviewer tìm ra (mục 9)
2. `MOCK=1 PORT=3300 node src/server.js` (do script tự khởi động), kết hợp Chrome CDP ở 1080×1920. Kết quả:
   - sân khấu có ≥ 6 nhân vật sau ~7 s (đo được 9–12)
   - mỗi theme có cảnh tương tác thật: celebrate / dance + wave / heart + bong bóng
   - canvas không rỗng: 205–237 nghìn pixel đặc (26–30% band 1080×730), 1190–1510 màu
   - cap giữ ở 12/12 khi bắn 20 viewer cùng lúc (theo dõi mỗi 16 ms trong 2,5 s)
   - đổi scale / max qua WS áp dụng ngay (pixel 15, 6/6); tắt thì ẩn canvas và huỷ rAF; bật lại thì chạy lại
   - nhảy tập thể xảy ra ở giây 33 thời gian sân khấu; có 4–9 lần chào nhau
   - panel: slider / công tắc / nút đi tới server, không tràn ngang ở 1080 và 390 px
   - **0 console error**
3. Layout (đo bằng `getBoundingClientRect`, 1080×1920):
   - sân khấu y 960–1690 (38%)
   - banner 96–216, leaderboard 326–713, combo 653–827: không giao nhau với sân khấu
   - ticker bắt đầu ở y 1711, nằm dưới sân khấu
   - z-index: particles 1 < nhân vật 2 < banner / leaderboard / combo / ticker 3
   - canvas có `pointer-events: none`

Ảnh (`docs/shots/`, chụp trên nền tối để dễ xem; OBS thật nhận nền trong suốt):
- `characters-temple.png`, `characters-neon.png`, `characters-tet.png`: toàn khung 1080×1920 cho 3 theme
- `characters-{temple,neon,tet}-stage.png`: cắt riêng dải sân khấu
- `characters-group-dance-stage.png`: lúc nhảy tập thể
- `characters-scale5-stage.png`: scale 5
- `characters-panel.png`, `characters-panel-390.png`: mục "Nhân vật pixel" trên panel
- Số liệu chi tiết: `characters-report.json` (headful) và `characters-report-headless.json`

## 8. Thay đổi ảnh hưởng tới phần có sẵn (nói rõ)

- **`scripts/screenshots.js`: ngưỡng "PNG có pixel trong suốt" hạ từ 30% xuống 25%.** Sau khi thêm nhân vật, ảnh temple ở 390 px chỉ còn 29,6% trong suốt nên check cũ fail. Nền trang vẫn được kiểm trong suốt bằng check `transparentBg` riêng.
- Chạy lại các script cũ đã **ghi đè** ảnh và report trong `docs/shots/` (temple / neon / tet / 390 / panel…). Các ảnh này giờ có nhân vật.
- `POST /api/config` giờ merge riêng khoá lồng `characters`; các khoá cũ vẫn ghi đè như trước. Hợp đồng API cũ giữ nguyên (`gift.diamond`, `POST /api/mock/stop`, …). 70 test cũ không phải sửa.
- Mock mode: khi boot có thêm 8 sự kiện `join` (được đếm vào `counters.emitted`).
- `docs/guide/doc.html` đang có thay đổi chưa commit (thêm trang "Hai lỗi kết nối khó nhất"). **Không phải do tôi sửa**: lúc bắt đầu working tree sạch, có vẻ một phiên khác đang sửa song song. Lưu ý: trong lúc làm, tôi có lỡ chạy `git stash` rồi `git stash pop` ngay sau đó. Nội dung file đó và mọi file khác đã được kiểm lại, còn nguyên.

## 9. Review độc lập và đã sửa

Một reviewer độc lập đọc diff, báo 0 lỗi nặng, 4 rủi ro và 2 câu hỏi. Đã xử lý tất cả; các sửa đều có test:
1. Nguồn ngang 1920×1080: band 410 px làm mọi nhân vật dồn về một làn sâu. Đã sửa: cỡ pixel giờ bị giới hạn theo chiều cao band (scale 3 cho 5 px), và `minY` tính theo chiều cao sprite thật.
2. Với `max` = 1, người đang bị đẩy ra mà comment lại thì tự đẩy mình ra lần nữa, và người đang chờ không bao giờ vào được. Đã sửa: không bao giờ chọn người vừa tương tác làm nạn nhân; nếu không còn ai khác thì bỏ người chờ lâu nhất.
3. ID viewer giả có thể trùng (ngẫu nhiên trong 1e6). Đã sửa: dùng tag ngẫu nhiên mỗi lần chạy cộng bộ đếm (test 1000 id không trùng).
4. `CharacterLayer.say` bị chép nhầm và sẽ ném lỗi nếu được gọi. Đã xoá.
5. Hỏi: spawn khi đang LIVE thật có bắn comment giả vào ticker không? **Đã đổi**: khi TikTok đang kết nối, `/api/characters/spawn` chỉ tạo `join`, không tạo comment giả.
6. Hỏi: `greet(8)` chỉ chạy lúc boot thì overlay mở sau có thấy đám đông không? Giữ nguyên, vì stream mock (2 sự kiện/s từ 12 người) lấp sân khấu trong vài giây. Đã đo: 9–12 nhân vật sau ~7 s khi mở overlay sau boot.

## 10. Chưa làm được / hạn chế (nói thật)

- **Chưa đo trong OBS thật.** 60 fps là số đo trong Chrome có cửa sổ trên macOS. Chưa chạy trong OBS Browser Source (CEF), chưa thử Windows, chưa thử máy yếu. Headless chỉ đạt ~12 fps vì giới hạn của chính headless Chrome (mục 6).
- **Chưa thử với phòng LIVE thật.** Không có tài khoản để test, nên chưa kiểm nhân vật với lưu lượng thật: hàng trăm like/giây, nhiều người join liên tục. Với cap 12 và luật "like đầu tiên cũng tạo nhân vật", phòng đông sẽ **thay người liên tục** (LRU đẩy ra / rơi vào). Mọi thứ đúng logic nhưng có thể trông ồn ào. Có thể sau này cần tuỳ chọn "chỉ tạo nhân vật khi join / comment / gift".
- **Chồng hình theo chiều sâu.** Separation chỉ đẩy nhau khi cùng độ sâu (< 0,6 thân). Nhân vật ở làn trước / sau vẫn có thể che nhau (cố ý, giả 3D), và tên hoặc bong bóng có thể đè lên nhau hoặc che đầu nhân vật phía sau. Mô phỏng 90 s với 12 nhân vật: trung bình 0,03 cặp chồng cùng làn.
- **Chữ không phải font pixel.** Tên và bong bóng dùng font hệ thống của theme (`--font-body`) để hiển thị đúng dấu tiếng Việt. Emoji trong comment cũng là emoji hệ thống, không phải pixel.
- **"Ráy tai"** trong yêu cầu được hiểu thành **tai nghe** và **tai mèo**. Nếu ý khác (ví dụ khuyên tai) thì cần chỉnh.
- **Không dùng avatar** TikTok (yêu cầu ghi là tuỳ chọn).
- **Trạng thái nhân vật chỉ nằm phía client.** Reload overlay thì sân khấu trống. Nhân vật quay lại khi người xem tương tác tiếp; vương miện được khôi phục từ `hello`.
- **Layout hẹp (390 px).** Hộp combo (top 46%) nằm đè lên mép trên của band. Nhân vật luôn nằm dưới combo nhờ z-index nên không che combo, nhưng bong bóng chat cao có thể bị combo che.
- **Hook debug** `window.__overlay.benchCharacters(n)` làm thời gian sân khấu chạy nhanh thêm n frame. Chỉ dùng cho script verify.
- `/api/characters/spawn` không có rate limit (chỉ giới hạn 1–20 mỗi lần gọi). Vẫn như phần API cũ: chỉ dành cho localhost, không có xác thực.
