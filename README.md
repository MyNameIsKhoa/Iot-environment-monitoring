# Warehouse Monitor ESP8266 - upgraded demo firmware

## Ứng dụng Android

Ứng dụng Flutter nằm trong [`mobile/`](mobile/README.md), dùng cùng Firebase với website. Có đăng nhập người xem, tổng quan realtime, biểu đồ, lịch sử phân trang/CSV và sự kiện. Xem README của ứng dụng để mở bằng Android Studio và chạy APK thử nghiệm.

## Website và GitHub Pages

Website mới nằm trong [`docs/`](docs/) để GitHub Pages phục vụ trực tiếp, không cần npm/build. Nó dùng đúng `/devices/warehouse01/latest` và `/devices/warehouse01/logs` của firmware này. Có trạng thái trực tiếp, nhiệt độ/độ ẩm, cảnh báo độ ẩm theo ngưỡng firmware, mức bụi tương đối và ADC thô, biểu đồ 1 giờ đến 1 tháng với tooltip từng mẫu, lịch sử 50 dòng mỗi trang, CSV và danh sách lần đổi trạng thái rút từ 100 log gần nhất. Ô PM2.5 và μg/m³ hiển thị chưa hiệu chuẩn cho đến khi có dữ liệu đo đối chiếu đáng tin. Số đo cũ được đánh dấu khi ESP offline. Không có nhánh `health` hoặc `events` trong firmware một bo này.

1. `docs/config.js` đã có **Firebase Web API key, database URL và `appId` công khai**. Xem lại `authDomain`/project ID/URL theo đúng config Web App trước khi đẩy GitHub. API key web không phải mật khẩu; **đừng đưa Wi-Fi password, refresh token hay service-account key vào `docs/`**.
2. Firebase Authentication: bật **Email/Password**, tạo tài khoản người xem riêng. UID người xem `WoUMKEqE90QejJiyfgCRxRbVDHt1` và UID Anonymous của ESP `UYeyVdMbc3hf7HrtjUBpVvJmqcq2` đã được điền vào `firebase.rules.restricted.json`. Publish rules ở **Realtime Database → Rules**. Rules chỉ cho UID web đọc `latest`/`logs`, UID ESP ghi hai nhánh đó; `logs` có index `timestamp` cho phân trang. Không dùng rules demo khi đưa web lên mạng công khai.
3. Thử trước trên máy: mở terminal trong `docs/`, chạy `python -m http.server 8080` rồi vào `http://localhost:8080/`. Đăng nhập tài khoản web để xem Firebase. Khi chưa có dữ liệu, kiểm tra firmware đã ghi `devices/warehouse01/latest` và `logs`.
4. Đẩy **thư mục dự án này làm gốc repository GitHub**. Vào repository **Settings → Pages → Build and deployment**, chọn **Deploy from a branch**, branch `main`, folder `/docs`, rồi Save. URL sẽ có dạng `https://<username>.github.io/<repo>/`; file web dùng đường dẫn tương đối nên chạy được dưới tên repo bất kỳ. Nếu đẩy cả thư mục cha `IOT-environment-monitoring` làm repo, GitHub Pages `/docs` sẽ không thấy thư mục con này: cần chuyển/copy `docs/` ra gốc repo hoặc dùng GitHub Actions.
5. Vào link Pages (HTTPS) rồi đăng nhập bằng **tài khoản viewer**, không dùng tài khoản/UID ESP. Nếu báo `permission-denied`, kiểm tra UID và rules; nếu không có log, kiểm tra `timestamp` là epoch milliseconds và chỉ mục `timestamp` đã publish.

**Trước khi đẩy GitHub:** file Arduino thật hiện đọc `warehouse_monitor_esp8266/secrets.h`, đã được `.gitignore` loại trừ. File này giữ Wi-Fi và API key cục bộ; `secrets.example.h` là mẫu. Nếu một bản chứa mật khẩu đã từng được push lên GitHub, hãy thay mật khẩu đó vì `.gitignore` không xóa lịch sử cũ. Cấu hình public của web ở `docs/config.js` không chứa Wi-Fi password.

## Features
- ESP8266 NodeMCU ESP-12E, one board only; DHT22, Sharp GP2Y1014AU0F, LCD 1602 PCF8574 via I2C level shifter, active 5V buzzer via NPN transistor.
- Read DHT22 and GP2Y every 2.5 s, local alarms with hysteresis and error states.
- Single fixed LCD 1602 screen with temperature, humidity, qualitative dust level and overall status. No `lcd.clear()` per sample.
- Humidity alarm: edit `HUMIDITY_ALARM_HIGH_PCT` / `HUMIDITY_ALARM_LOW_PCT` in `warehouse_monitor_esp8266/warehouse_monitor_esp8266.ino`; defaults are 80% and 40%. Clear thresholds use 2% hysteresis (`HIGH_CLEAR=78`, `LOW_CLEAR=42`). Humidity alarm makes ESP report `DANGER` and drives the buzzer locally, independent of Wi-Fi/Firebase.
- Relative dust rise warning after 12 clean-air baseline readings (~30 s). LCD shows `IT` (LOW), `VUA` (MEDIUM), `NHIEU` (HIGH). **NOT PM2.5 ug/m3 or AQI**; thresholds are uncalibrated demo starting points and require real-board tuning.
- Firebase also records `dustLevel` (LOW/MEDIUM/HIGH/CALIBRATING/ERROR/DISABLED) and numeric `dustDeltaAdc` when available.
- Firebase Realtime Database REST: PUT `/devices/warehouse01/latest`, POST `/devices/warehouse01/logs` every 15 s; Firebase server timestamp, includes status ERROR/CALIBRATING.
- Firebase Anonymous Authentication refresh token cached in ESP8266 LittleFS, so device UID survives ordinary resets. If cache is wiped or refresh token revoked, a new UID will require updating restricted rules.

## Wiring
| ESP8266 | Destination |
| --- | --- |
| USB | Supply NodeMCU |
| VIN (if confirmed ~5V from USB) | LCD backpack VCC, level-shifter HV, GP2Y Vcc/LED supply, buzzer V+ |
| 3V3 | Level-shifter LV, DHT22 VCC |
| GND | All GND lines including BOTH level-shifter GND pins if present |
| D1/GPIO5 | Shifter LV2 to HV2 then LCD SCL |
| D2/GPIO4 | Shifter LV1 to HV1 then LCD SDA |
| D5/GPIO14 | DHT22 DATA |
| D6/GPIO12 | 1k resistor -> NPN Q1 base, Q1 collector -> GP2Y LED pin 3, emitter -> GND |
| D7/GPIO13 | 1k resistor -> NPN Q2 base, Q2 collector -> active buzzer negative, emitter -> GND |
| A0 | GP2Y Vo through 47k/10k external divider ONLY after checking actual A0 voltage range |

GP2Y1014AU0F pinout (verify the physical sensor connector/datasheet, never trust color): pin 1 V-LED -> 5V through 150 ohm with 220uF capacitor from pin1 to GND (+ at pin1), pin2 LED-GND -> GND, pin3 LED -> Q1 collector, pin4 S-GND -> GND, pin5 Vo -> 47k upper resistor -> ADC node / 10k lower resistor to GND, pin6 Vcc -> 5V. Q1/Q2 B/C/E pin ordering depends on transistor model. Avoid 5V on ESP GPIO. The NodeMCU USB/VIN connection varies with board revision; verify it before using. Use a robust 5V supply capable of powering your whole circuit and make every GND common.

### Important: dust sensor wiring note
The Sharp GP2Y1014AU0F is usually shown with its internal measuring LED supply circuit and an LED drive pin. Check the official sensor datasheet/pin numbering before applying power. Do not connect an MCU GPIO directly to 5V or a buzzer load. If your GP2Y comes on a conditioned breakout board (not bare 6-wire sensor), its onboard resistor/capacitor/driver may change these connections.

## Open in Arduino IDE / PlatformIO
- **Arduino IDE**: copy `warehouse_monitor_esp8266/secrets.example.h` to `secrets.h` if the local file does not already exist, fill your own Wi-Fi/Firebase settings, then open `warehouse_monitor_esp8266/warehouse_monitor_esp8266.ino`.
- **PlatformIO**: open the folder holding `platformio.ini`, then build/upload `src/main.cpp`. Đây là bản firmware riêng có cấu hình mẫu; thay giá trị cấu hình trước khi nạp. Thay đổi trong `.ino` không tự đồng bộ sang `src/main.cpp`.

## Arduino IDE / libraries
- Install **ESP8266 Boards** package (NodeMCU 1.0 (ESP-12E Module)).
- Install **DHT sensor library** by Adafruit plus **Adafruit Unified Sensor**.
- Install a **LiquidCrystal_I2C** library exposing `lcd.init()`.
- Install **ArduinoJson v7** (`JsonDocument`).
- `LittleFS` ships with ESP8266 Arduino core.
- The `.ino` sketch filename normally matches the containing Arduino sketch folder name. If Arduino prompts to move it to a same-named folder, accept.

## Firebase steps
1. Create Firebase project -> Realtime Database. This sketch does **NOT** write Cloud Firestore.
2. Enable Authentication -> Sign-in method -> Anonymous.
3. Obtain Web API key (project settings) and Realtime Database URL.
4. Edit Wi-Fi, FIREBASE_API_KEY, FIREBASE_DB_URL in the local ignored `warehouse_monitor_esp8266/secrets.h` and set ENABLE_FIREBASE=true in the sketch after testing sensors.
5. During a local/private demo only, apply `firebase.rules.demo.json` in **Realtime Database -> Rules**. ANY Firebase-authenticated user in this project can read/write the demo device path, so this is **not suitable for production**.
6. Boot ESP, open serial monitor at 115200 baud, find `Firebase anonymous UID: ...`. Logs should show `Firebase latest: HTTP 204` and `Firebase log: HTTP 204`.
7. To restrict database, replace `PASTE_ESP_UID` and `PASTE_DASHBOARD_UID` in `firebase.rules.restricted.json` with the respective Firebase Auth user UIDs and publish these rules. The dashboard signs in with its own Email/Password account; the ESP uses its existing Anonymous Auth UID.
8. For realtime dashboard: subscribe with Firebase Web SDK to `devices/warehouse01/latest`; query `logs` separately for charts. Rules must authorize its signed-in account.

### Nếu Serial Monitor báo `Firebase latest: HTTP 401` / `Permission denied`

Đây là lỗi quyền ghi Realtime Database. Trong firmware, ESP đăng nhập **Anonymous Auth** và ghi bằng UID của chính nó; UID web `WoUMKEqE90QejJiyfgCRxRbVDHt1` chỉ được đọc. Rules hiện đã cấp quyền ghi cho UID ESP `UYeyVdMbc3hf7HrtjUBpVvJmqcq2`. **Publish nội dung file** `firebase.rules.restricted.json` vào Firebase Console → Realtime Database → Rules, rồi thử gửi lại; sửa file trên máy chưa đổi rules đang chạy trên Firebase. Nếu UID ESP thay đổi sau khi xóa LittleFS, cập nhật rules theo UID mới. Cũng kiểm tra `FIREBASE_DB_URL` và Web API key thuộc **cùng Firebase project**. Không dùng UID web làm quyền ghi và không chuyển rules thành `auth != null` khi site đã công khai.

## Security boundaries
- **This firmware calls `client.setInsecure()`: HTTPS traffic is encrypted but certificates are NOT verified**, so credentials and data are vulnerable to MITM. For real use replace this with proper CA validation, configured time and a maintained trust store, or route sensor readings through a hardened backend.
- Cached `refreshToken` in LittleFS is **plaintext at rest**. Protect the ESP physically; use device credentials or a backend with revocable scoped access for production. Avoid printing tokens to Serial or checking them into source control.
- Firebase Web API key is a project identifier, not equivalent to a server service-account key; never put a Firebase service-account private key on the ESP.
- The `firebase.rules.demo.json` uses auth != null, **not device-isolated authorization**. Anonymous sign-in does not make it secure against other authenticated project clients.

## LCD layout (one screen, no rotating pages)
```
T:30.0C H:60%
B:NHIEU S:DANGER
```
- Row 1: Celsius temperature (1 decimal), humidity as a whole percent.
- Row 2: `B` is relative dust-level text, `S` is status. Normal states include `SAFE`, `DANGER`, `ERROR`, `CAL` (calibrating) and `PARTIAL` when dust is disabled.
- If dust is unavailable, the LCD shows `B:ERR` or `B:OFF`. LCD does not show Wi-Fi due to the 16-character width; Wi-Fi remains in Serial output and `wifiRssiDbm` in Firebase.
- The text is ASCII without Vietnamese accents because common LCD1602 character ROMs do not display Vietnamese reliably.

## Calibrate dust warning for your board
- In clean air at boot, let it collect 12 samples (~30 seconds), read `Dust clean-air baseline: X ADC` on Serial Monitor.
- Expose GP2Y to a safe, brief dust source, record `Delta`. Do not blow dangerous dust or smoke toward yourself or the sensor.
- Demonstration default labels: `delta < 15` = IT/LOW; `delta >= 15` = VUA/MEDIUM; `delta >= 35` triggers NHIEU/HIGH, remaining HIGH until `delta <= 20` to prevent rapid toggling. Tune `DUST_LEVEL_MEDIUM_DELTA_ADC`, `DUST_ALARM_ON_DELTA_ADC` and `DUST_ALARM_OFF_DELTA_ADC` according to baseline/noise and short, safe real tests. These thresholds are **not regulated air-quality standards**.
- When the board reboots in already-dusty air, the new baseline can mask the dust: this demo is useful for detecting **changes**, not absolute pollution.
- WARNING: auto-calibrating at every startup can hide pre-existing dust. For any serious monitoring, use a calibrated baseline and a real PM2.5 sensor. This firmware is classroom demonstration only.
- If `DustADC=0` or `BUI:SENSOR ERROR`, inspect Vo wiring, GND, LED circuit, sensor power, and ADC attenuation. A disconnected sensor can sometimes return nonzero ADC; this error detection is only a heuristic.

## Example database node
```
devices/
  warehouse01/
    latest/       // newest JSON object
    logs/
      -AutoPushId1/  // time-stamped history JSON
      -AutoPushId2/
```

## Quick test
- Start with `ENABLE_FIREBASE=false`, Wi-Fi optional, confirm LCD and DHT22.
- Set `ENABLE_DUST_SENSOR=false` if GP2Y wiring is not finished; add it later.
- For humidity, temporarily set `HUMIDITY_ALARM_HIGH_PCT` below current room humidity or `HUMIDITY_ALARM_LOW_PCT` above it; upload the sketch and verify `HumidityAlarm=HIGH/LOW`, `Status=DANGER`, and buzzer. Restore 80/40 afterward. The buzzer clears at the configured hysteresis clear threshold.
- Trigger heat gently to test temperature threshold 35 C; buzzer remains ON until <=33.5 C.
- After GP2Y assembled and baseline collected, tune dust alarm using Serial Monitor.
- Enable Firebase last, check HTTP status 204 and resulting nodes in Firebase Console.
