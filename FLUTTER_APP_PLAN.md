# Kế hoạch ứng dụng Flutter cho Warehouse Monitor

> Cập nhật triển khai: `mobile/` đã được tạo với Android app ID `com.warehousemonitor.warehouse_monitor_app`, đã đăng ký Firebase Android app, có đăng nhập viewer, tổng quan, biểu đồ, lịch sử phân trang/CSV và sự kiện. Chế độ dữ liệu giả đã được gỡ khỏi app và website. `flutter analyze`, 6 bài `flutter test` và `flutter build apk --debug` đã qua trước thay đổi này. Chưa đăng nhập Firebase thật vì không lưu mật khẩu viewer trong dự án; bước đó cần tài khoản người xem của chủ dự án. Xem `mobile/README.md` để chạy app. Các dòng trạng thái cũ bên dưới là kết quả khảo sát trước khi viết app.

## Mục tiêu và phạm vi

Tạo ứng dụng **Android** trong `mobile/`, dùng cùng Firebase Realtime Database và tài khoản người xem với website. Phiên bản đầu đọc dữ liệu; không sửa ngưỡng cảnh báo hay ghi vào database. Giao diện tiếng Việt, dùng được trên điện thoại và máy tính bảng. Không đưa mật khẩu Wi-Fi, tài khoản đăng nhập hoặc token vào mã nguồn.

## Tình trạng máy đã kiểm tra (18/10/2026)

| Thành phần | Kết quả |
| --- | --- |
| Flutter / Dart | Flutter 3.44.6, Dart 3.12.2 tại `D:\flutter` |
| Android Studio / SDK | `D:\Android\Android Studio`, SDK `D:\Android\Sdk`, JDK 21 đi kèm Studio |
| Công cụ Firebase | `flutterfire` và `firebase` có trong PATH; chưa chạy quy trình cấu hình Android |
| Emulator | AVD `Pixel_8` cũ thiếu `config.ini` và không chạy. Đã tạo AVD `Warehouse_Pixel_8` từ ảnh Android 15 x86_64 có sẵn. Flutter nhìn thấy emulator một lần, nhưng kết nối chưa ổn định. |
| Android licenses | `flutter doctor -v` báo còn license chưa được chấp nhận. Người dùng cần đọc và tự chấp nhận bằng `flutter doctor --android-licenses`. |
| ADB | PATH ưu tiên `C:\adb\adb.exe` (bản 2014) trong khi SDK có `D:\Android\Sdk\platform-tools\adb.exe` (bản 2026). ADB cũ tự chạy lại và tranh cổng với bản mới; phải xử lý trước khi chạy thử ổn định. |
| Firebase Android | Chưa có `firebase_options.dart` hoặc cấu hình ứng dụng Android trong repository. Cấu hình web hiện tại không thay cho bước đăng ký Android app. |

Chưa thể xác nhận `flutter run` trên Android vì repository chưa có ứng dụng Flutter, Android licenses chưa đủ và ADB đang xung đột. Cảnh báo Visual Studio C++ trong `flutter doctor` chỉ liên quan build ứng dụng **Windows**, không phải mục tiêu Android này.

## Việc cần hoàn tất trước khi chạy app

1. Sửa PATH/tiến trình nền để chỉ dùng ADB của `D:\Android\Sdk\platform-tools`. Kiểm tra `where.exe adb` và `adb devices -l` sau khi sửa; emulator phải hiện liên tục ở trạng thái `device`.
2. Người dùng đọc và chấp nhận Android SDK licenses bằng `flutter doctor --android-licenses`, rồi chạy lại `flutter doctor -v`.
3. Tạo Flutter project trong `mobile/` với một Android application ID cố định; đăng ký **Android app** trong Firebase project hiện tại bằng `flutterfire configure`. File sinh ra `lib/firebase_options.dart` chứa mã cấu hình công khai. Không nhập tài khoản/mật khẩu viewer vào file này.
4. Dùng tài khoản Firebase Authentication Email/Password người xem hiện có. Rules hiện cấp UID người xem quyền đọc `devices/warehouse01/latest` và `logs`; nếu dùng tài khoản khác, phải cấp UID đó quyền đọc tương ứng.

## Dữ liệu dùng chung với website

- `devices/warehouse01/latest`: lắng nghe realtime cho nhiệt độ, độ ẩm, mức bụi, trạng thái, Wi-Fi RSSI và thời điểm cập nhật.
- `devices/warehouse01/logs`: truy vấn theo `timestamp`, giới hạn 1.500 bản ghi cho biểu đồ 1/6 giờ; lịch sử tải 50 bản ghi mỗi trang; 100 log gần nhất để suy ra lần đổi trạng thái.
- Dùng `timestamp` UTC epoch milliseconds từ Firebase; hiển thị theo múi giờ điện thoại. `SAFE`, `DANGER`, `ERROR`, `CALIBRATING`, `PARTIAL`; suy ra `OFFLINE` khi `/latest` quá 45 giây.
- Bụi hiển thị **ADC** và **ΔADC**, kèm chú thích đo tương đối. Không hiển thị PM2.5, µg/m³ hoặc AQI khi chưa hiệu chuẩn.

## Lộ trình triển khai

### 1. Khung ứng dụng và xác nhận build

- Chạy app mặc định trên `Warehouse_Pixel_8`, sau đó `flutter analyze` và một bài kiểm tra widget cơ bản. Chỉ tiếp tục tích hợp khi emulator kết nối ổn định.

### 2. Đăng nhập và dữ liệu

- Thêm các gói chính thức `firebase_core`, `firebase_auth`, `firebase_database`; cấu hình Android bằng FlutterFire CLI.
- Màn hình đăng nhập Email/Password; giữ phiên đăng nhập theo Firebase Auth, có nút đăng xuất.
- Tạo model/parser chịu được trường `null`, trạng thái lỗi và dữ liệu thiếu; thử với JSON Firebase đã xuất. Không ghi dữ liệu từ ứng dụng.
- Tầng dữ liệu lắng nghe `/latest`, giới hạn truy vấn `/logs` và hủy listener khi rời màn hình.

### 3. Giao diện chính

- **Tổng quan:** SAFE/DANGER/ERROR/OFFLINE, nhiệt độ °C, độ ẩm %, bụi ADC/ΔADC, Wi-Fi RSSI, “cập nhật N giây trước”; đánh dấu rõ số đo cũ.
- **Biểu đồ:** chọn nhiệt độ/độ ẩm/ADC/ΔADC và 1/6 giờ; trục X/Y có số, chạm để xem giá trị và giờ chính xác, ngắt đường khi thiếu dữ liệu; min/max/trung bình và số mẫu hợp lệ/tổng bản ghi đã tải.
- **Lịch sử:** ngày/trạng thái, 50 bản ghi mỗi trang, tải tiếp khi cần; xuất CSV chỉ cho phần đã tải và ghi rõ phạm vi đó.
- **Sự kiện:** suy ra các lần đổi trạng thái/cảnh báo từ 100 log gần nhất, giống website.

### 4. Kiểm thử và bàn giao

- Unit test parser, quy tắc OFFLINE, phân trang/dedup và nhận biết khoảng thiếu dữ liệu; widget test các trạng thái SAFE/DANGER/ERROR/OFFLINE.
- `flutter analyze`, `flutter test`, `flutter run -d emulator-5554`; đăng nhập Firebase thật rồi so các giá trị với website và Firebase Console.
- Tạo APK thử nghiệm cho Android, hướng dẫn cài trên điện thoại; build phát hành có ký riêng khi cần phân phối. Ghi rõ phần chưa kiểm tra trên phần cứng thật.

## Ngoài phạm vi phiên bản đầu

Thông báo đẩy khi app đã đóng cần thêm Firebase Cloud Messaging và một thành phần phía server phát sự kiện. Chỉ lắng nghe Realtime Database trong app không bảo đảm cảnh báo khi app chạy nền hoặc đã bị đóng; việc này nên làm ở giai đoạn sau.
