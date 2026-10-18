/*
  Warehouse Monitor - ESP8266 NodeMCU ESP-12E (no UNO, no LoRa)
  Arduino IDE or PlatformIO with Arduino framework

  Wiring (see README):
  D1 GPIO5 -> LCD I2C SCL via level shifter
  D2 GPIO4 -> LCD I2C SDA via level shifter
  D5 GPIO14 -> DHT22 DATA (DHT module powered at 3V3)
  D6 GPIO12 -> NPN Q1 base resistor -> GP2Y1014AU0F LED drive
  D7 GPIO13 -> NPN Q2 base resistor -> active 5V buzzer
  A0 -> GP2Y Vo through 47k/10k external attenuator (VERIFY ADC range)

  Dependencies: ESP8266 board core, DHT sensor library by Adafruit,
  Adafruit Unified Sensor, LiquidCrystal_I2C (API lcd.init()), ArduinoJson v7.

  SECURITY: This lab/demo version uses setInsecure() for HTTPS. It ENCRYPTS
  traffic but does NOT authenticate servers. Never use this mode to protect
  valuable accounts, data, or production equipment.
*/

#include <Arduino.h>
#include <Wire.h>
#include <ESP8266WiFi.h>
#include <ESP8266HTTPClient.h>
#include <WiFiClientSecureBearSSL.h>
#include <LittleFS.h>
#include <DHT.h>
#include <LiquidCrystal_I2C.h>
#include <ArduinoJson.h>
#include <math.h>

// -------- EDIT THESE FIRST --------
const char* WIFI_SSID = "YOUR_WIFI_NAME";
const char* WIFI_PASSWORD = "YOUR_WIFI_PASSWORD";
const bool ENABLE_FIREBASE = false;  // Set true AFTER sensors and database are ready.
const char* FIREBASE_API_KEY = "YOUR_FIREBASE_WEB_API_KEY";
const char* FIREBASE_DB_URL = "https://YOUR_DATABASE_URL"; // No trailing slash.
const char* DEVICE_ID = "warehouse01";

// Sensor configuration
const uint8_t LCD_ADDRESS = 0x27;  // Confirmed with your I2C scanner.
const float TEMP_ALARM_ON_C = 35.0f;
const float TEMP_ALARM_OFF_C = 33.5f;  // Hysteresis avoids rapid on/off.
const bool ENABLE_DUST_SENSOR = true; // Set false until GP2Y wiring is installed.
const uint8_t DUST_BASELINE_SAMPLES = 12; // ~30 seconds in clean air after boot.
const uint16_t DUST_LEVEL_MEDIUM_DELTA_ADC = 15; // DEMO ONLY: LOW below this, MEDIUM above it.
const uint16_t DUST_ALARM_ON_DELTA_ADC = 35; // DEMO ONLY: HIGH/ALARM after this.
const uint16_t DUST_ALARM_OFF_DELTA_ADC = 20;
const uint16_t DUST_MIN_PLAUSIBLE_ADC = 5; // Quick disconnected-sensor indication only.

// Timing
const unsigned long SAMPLE_INTERVAL_MS = 2500UL;
const unsigned long UPLOAD_INTERVAL_MS = 15000UL;
const unsigned long WIFI_RETRY_INTERVAL_MS = 15000UL;
const unsigned long TOKEN_VALID_MS = 50UL * 60UL * 1000UL;

const uint8_t PIN_DHT = D5;
const uint8_t PIN_DUST_LED = D6;
const uint8_t PIN_BUZZER = D7;
const char* AUTH_CACHE_FILE = "/firebase_auth.json";

DHT dht(PIN_DHT, DHT22);
LiquidCrystal_I2C lcd(LCD_ADDRESS, 16, 2);

float temperatureC = NAN;
float humidityPct = NAN;
uint16_t dustAdc = 0;
uint16_t dustBaselineAdc = 0;
uint32_t dustBaselineSum = 0;
uint8_t dustBaselineCount = 0;
bool dhtOK = false;
bool dustOK = false;
bool dustCalibrated = false;
bool tempAlarm = false;
bool dustAlarm = false;
bool filesystemOK = false;

unsigned long lastSampleMs = 0;
unsigned long lastUploadMs = 0;
unsigned long lastWiFiTryMs = 0;
unsigned long tokenIssuedMs = 0;
String idToken;
String refreshToken;
String firebaseUid;

// GP2Y LED drive circuit MUST match the NPN circuit described in README.
uint16_t readDustAdc() {
  uint32_t sum = 0;
  for (uint8_t i = 0; i < 10; ++i) {
    digitalWrite(PIN_DUST_LED, HIGH);    // NPN ON -> GP2Y pin 3 LOW.
    delayMicroseconds(280);
    sum += analogRead(A0);
    delayMicroseconds(40);
    digitalWrite(PIN_DUST_LED, LOW);     // NPN OFF.
    delayMicroseconds(9680);
    yield();
  }
  return static_cast<uint16_t>(sum / 10);
}

const char* statusText() {
  if (tempAlarm || dustAlarm) return "DANGER";
  if (!dhtOK || (ENABLE_DUST_SENSOR && !dustOK)) return "ERROR";
  if (ENABLE_DUST_SENSOR && !dustCalibrated) return "CALIBRATING";
  if (!ENABLE_DUST_SENSOR) return "PARTIAL"; // Dust is off: cannot claim all sensors are safe.
  return "SAFE";
}

void lcdLine(uint8_t row, String text) {
  if (text.length() > 16) text.remove(16);
  lcd.setCursor(0, row);
  lcd.print(text);
  for (size_t i = text.length(); i < 16; ++i) lcd.print(' ');
}

// Labels are RELATIVE to a startup baseline, not calibrated PM2.5/AQI.
// Keep HIGH while the dust hysteresis alarm is on to avoid label flicker.
const char* dustLevelText() {
  if (!ENABLE_DUST_SENSOR) return "DISABLED";
  if (!dustOK) return "ERROR";
  if (!dustCalibrated) return "CALIBRATING";
  if (dustAlarm) return "HIGH";
  const int delta = static_cast<int>(dustAdc) - static_cast<int>(dustBaselineAdc);
  return (delta >= DUST_LEVEL_MEDIUM_DELTA_ADC) ? "MEDIUM" : "LOW";
}

const char* dustLabelLcd() {
  if (!ENABLE_DUST_SENSOR) return "OFF";
  if (!dustOK) return "ERR";
  if (!dustCalibrated) return "CHO";
  if (dustAlarm) return "NHIEU";
  const int delta = static_cast<int>(dustAdc) - static_cast<int>(dustBaselineAdc);
  return (delta >= DUST_LEVEL_MEDIUM_DELTA_ADC) ? "VUA" : "IT";
}

void showLcd() {
  // Exactly one screen: 2 rows x 16 characters, no page changes or lcd.clear().
  // Row 1: T:30.0C H:60%
  // Row 2: B:NHIEU S:DANGER (16 chars)
  String top = dhtOK
      ? String("T:") + String(temperatureC, 1) + "C H:" + String(humidityPct, 0) + "%"
      : String("T:ERR H:ERR");
  String state = statusText();
  if (state == "CALIBRATING") state = "CAL"; // Fit within 16 characters.
  String bottom = String("B:") + dustLabelLcd() + " S:" + state;
  lcdLine(0, top);
  lcdLine(1, bottom);
}

void updateSensors() {
  // Dust readings are relative, NOT calibrated PM2.5 (ug/m3).
  if (ENABLE_DUST_SENSOR) {
    dustAdc = readDustAdc();
    dustOK = dustAdc >= DUST_MIN_PLAUSIBLE_ADC && dustAdc < 1018;
    if (dustOK && !dustCalibrated) {
      dustBaselineSum += dustAdc;
      ++dustBaselineCount;
      if (dustBaselineCount >= DUST_BASELINE_SAMPLES) {
        dustBaselineAdc = dustBaselineSum / dustBaselineCount;
        dustCalibrated = true;
        Serial.printf("Dust clean-air baseline: %u ADC.\n", dustBaselineAdc);
      }
    }
    if (dustOK && dustCalibrated) {
      int delta = static_cast<int>(dustAdc) - static_cast<int>(dustBaselineAdc);
      if (!dustAlarm && delta >= DUST_ALARM_ON_DELTA_ADC) dustAlarm = true;
      if (dustAlarm && delta <= DUST_ALARM_OFF_DELTA_ADC) dustAlarm = false;
    } else {
      dustAlarm = false;
    }
  } else {
    dustOK = false;
    dustAlarm = false;
  }

  float h = dht.readHumidity();
  float t = dht.readTemperature();
  dhtOK = isfinite(t) && isfinite(h) && t >= -40 && t <= 80 && h >= 0 && h <= 100;
  if (dhtOK) {
    temperatureC = t;
    humidityPct = h;
    if (!tempAlarm && temperatureC >= TEMP_ALARM_ON_C) tempAlarm = true;
    if (tempAlarm && temperatureC <= TEMP_ALARM_OFF_C) tempAlarm = false;
  } else {
    temperatureC = NAN;
    humidityPct = NAN;
    tempAlarm = false;
  }

  // A failed sensor is ERROR, not SAFE. Buzzer sounds on validated threshold alerts.
  digitalWrite(PIN_BUZZER, (tempAlarm || dustAlarm) ? HIGH : LOW);
  showLcd();

  Serial.print(F("T="));
  if (dhtOK) Serial.print(temperatureC, 1); else Serial.print(F("ERR"));
  Serial.print(F("C H="));
  if (dhtOK) Serial.print(humidityPct, 1); else Serial.print(F("ERR"));
  Serial.print(F("% DustADC="));
  if (ENABLE_DUST_SENSOR) Serial.print(dustAdc); else Serial.print(F("OFF"));
  if (dustCalibrated) {
    Serial.print(F(" Base=")); Serial.print(dustBaselineAdc);
    Serial.print(F(" Delta="));
    Serial.print(static_cast<int>(dustAdc) - static_cast<int>(dustBaselineAdc));
  }
  Serial.print(F(" DustLevel=")); Serial.print(dustLevelText());
  Serial.print(F(" Status=")); Serial.print(statusText());
  Serial.print(F(" WiFi="));
  Serial.println(WiFi.status() == WL_CONNECTED ? F("ON") : F("OFF"));
}

// For classroom demo only: TLS encryption without certificate verification.
// Use verified CA certificates / a managed trust store before production use.
bool httpsRequest(const String& url, const char* method, const String& body,
                  const char* contentType, String& response, int& status) {
  BearSSL::WiFiClientSecure client;
  client.setInsecure();
  HTTPClient http;
  http.setTimeout(9000);
  status = -1;
  response = "";
  if (!http.begin(client, url)) {
    Serial.println(F("HTTPS begin failed"));
    return false;
  }
  http.addHeader("Content-Type", contentType);
  if (strcmp(method, "PUT") == 0) status = http.PUT(body);
  else status = http.POST(body);
  if (status > 0) response = http.getString();
  http.end();
  return status >= 200 && status < 300; // Firebase silent writes return 204.
}

void saveAuthCache() {
  if (!filesystemOK || refreshToken.isEmpty() || firebaseUid.isEmpty()) return;
  File f = LittleFS.open(AUTH_CACHE_FILE, "w");
  if (!f) {
    Serial.println(F("Could not save auth cache"));
    return;
  }
  JsonDocument doc;
  doc["refreshToken"] = refreshToken;
  doc["uid"] = firebaseUid;
  if (serializeJson(doc, f) == 0) Serial.println(F("Auth cache write failed"));
  f.close();
}

void loadAuthCache() {
  if (!filesystemOK || !LittleFS.exists(AUTH_CACHE_FILE)) return;
  File f = LittleFS.open(AUTH_CACHE_FILE, "r");
  if (!f) return;
  JsonDocument doc;
  DeserializationError err = deserializeJson(doc, f);
  f.close();
  if (err) {
    Serial.println(F("Invalid auth cache file"));
    return;
  }
  refreshToken = doc["refreshToken"].as<String>();
  firebaseUid = doc["uid"].as<String>();
  if (!refreshToken.isEmpty()) {
    Serial.println(F("Cached Firebase refresh token loaded"));
    Serial.print(F("Firebase UID: ")); Serial.println(firebaseUid);
  }
}

bool firebaseAnonymousSignUp() {
  String response;
  int code = -1;
  String url = String("https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=") + FIREBASE_API_KEY;
  if (!httpsRequest(url, "POST", "{\"returnSecureToken\":true}",
                    "application/json", response, code)) {
    Serial.printf("Firebase sign-up failed: HTTP %d\n", code);
    return false;
  }
  JsonDocument doc;
  if (deserializeJson(doc, response)) return false;
  idToken = doc["idToken"].as<String>();
  refreshToken = doc["refreshToken"].as<String>();
  firebaseUid = doc["localId"].as<String>();
  if (idToken.isEmpty() || refreshToken.isEmpty() || firebaseUid.isEmpty()) return false;
  tokenIssuedMs = millis();
  saveAuthCache();
  Serial.print(F("Firebase anonymous UID: ")); Serial.println(firebaseUid);
  return true;
}

bool firebaseRefreshToken() {
  if (refreshToken.isEmpty()) return false;
  String response;
  int code = -1;
  String url = String("https://securetoken.googleapis.com/v1/token?key=") + FIREBASE_API_KEY;
  String body = String("grant_type=refresh_token&refresh_token=") + refreshToken;
  if (!httpsRequest(url, "POST", body, "application/x-www-form-urlencoded", response, code)) {
    Serial.printf("Firebase token refresh failed: HTTP %d\n", code);
    return false;
  }
  JsonDocument doc;
  if (deserializeJson(doc, response)) return false;
  String newIdToken = doc["id_token"].as<String>();
  String newRefreshToken = doc["refresh_token"].as<String>();
  String newUid = doc["user_id"].as<String>();
  if (newIdToken.isEmpty() || newRefreshToken.isEmpty()) return false;
  idToken = newIdToken;
  refreshToken = newRefreshToken;
  if (!newUid.isEmpty()) firebaseUid = newUid;
  tokenIssuedMs = millis();
  saveAuthCache();
  return true;
}

bool firebaseAuthReady() {
  if (!idToken.isEmpty() && millis() - tokenIssuedMs < TOKEN_VALID_MS) return true;
  if (!refreshToken.isEmpty()) {
    // Preserve device UID. Do NOT silently create a new anonymous identity
    // on refresh failure: it could invalidate UID-restricted database rules.
    return firebaseRefreshToken();
  }
  return firebaseAnonymousSignUp();
}

void uploadToFirebase() {
  if (!ENABLE_FIREBASE || WiFi.status() != WL_CONNECTED) return;
  if (!firebaseAuthReady()) return;

  JsonDocument data;
  if (dhtOK) {
    data["temperatureC"] = temperatureC;
    data["humidityPct"] = humidityPct;
  } else {
    data["temperatureC"] = nullptr;
    data["humidityPct"] = nullptr;
  }
  data["dhtOK"] = dhtOK;
  data["dustOK"] = ENABLE_DUST_SENSOR && dustOK;
  data["dustCalibrated"] = ENABLE_DUST_SENSOR && dustCalibrated;
  data["dustLevel"] = dustLevelText(); // LOW/MEDIUM/HIGH; qualitative demo only.
  if (ENABLE_DUST_SENSOR && dustOK) data["dustAdc"] = dustAdc;
  else data["dustAdc"] = nullptr;
  if (ENABLE_DUST_SENSOR && dustCalibrated && dustOK) {
    data["dustBaselineAdc"] = dustBaselineAdc;
    data["dustDeltaAdc"] = static_cast<int>(dustAdc) - static_cast<int>(dustBaselineAdc);
  }
  data["temperatureAlarm"] = tempAlarm;
  data["dustAlarm"] = dustAlarm;
  data["status"] = statusText();
  data["wifiRssiDbm"] = WiFi.RSSI();
  data["timestamp"][".sv"] = "timestamp"; // Server-side UNIX time in ms.

  String body;
  serializeJson(data, body);
  String root = String(FIREBASE_DB_URL);
  if (root.endsWith("/")) root.remove(root.length() - 1);
  root += String("/devices/") + DEVICE_ID;
  String params = String(".json?auth=") + idToken + "&print=silent";
  String response;
  int code = -1;

  bool latestOK = httpsRequest(root + "/latest" + params, "PUT", body,
                               "application/json", response, code);
  Serial.printf("Firebase latest: HTTP %d\n", code);
  if (!latestOK) {
    if (code == 401) {
      Serial.print(F("Firebase write UID (compare with rules): ")); Serial.println(firebaseUid);
      if (response.indexOf("Permission denied") < 0) idToken = ""; // Refresh only an invalid/expired token.
    }
    if (!response.isEmpty()) Serial.println(response.substring(0, 150));
    return;
  }
  code = -1;
  bool logOK = httpsRequest(root + "/logs" + params, "POST", body,
                            "application/json", response, code);
  Serial.printf("Firebase log: HTTP %d\n", code);
  if (!logOK && !response.isEmpty()) Serial.println(response.substring(0, 150));
  if (code == 401) {
    Serial.print(F("Firebase write UID (compare with rules): ")); Serial.println(firebaseUid);
    if (response.indexOf("Permission denied") < 0) idToken = "";
  }
}

void setup() {
  Serial.begin(115200);
  Serial.println();
  Serial.println(F("Warehouse monitor starting..."));
  pinMode(PIN_DUST_LED, OUTPUT);
  pinMode(PIN_BUZZER, OUTPUT);
  digitalWrite(PIN_DUST_LED, LOW);
  digitalWrite(PIN_BUZZER, LOW);

  dht.begin();
  Wire.begin(D2, D1);  // SDA, SCL
  Wire.setClock(100000);
  lcd.init();
  lcd.backlight();
  lcdLine(0, "WAREHOUSE IOT");
  lcdLine(1, "Khoi dong...");

  filesystemOK = LittleFS.begin();
  if (filesystemOK) loadAuthCache();
  else Serial.println(F("LittleFS unavailable: login won't persist across resets"));

  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  lastWiFiTryMs = millis();
  lastSampleMs = millis() - SAMPLE_INTERVAL_MS;
  lastUploadMs = millis();
}

void loop() {
  unsigned long now = millis();
  if (WiFi.status() != WL_CONNECTED && now - lastWiFiTryMs >= WIFI_RETRY_INTERVAL_MS) {
    WiFi.disconnect();
    WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
    lastWiFiTryMs = now;
  }
  if (now - lastSampleMs >= SAMPLE_INTERVAL_MS) {
    lastSampleMs = now;
    updateSensors();
  }
  if (ENABLE_FIREBASE && now - lastUploadMs >= UPLOAD_INTERVAL_MS) {
    lastUploadMs = now;
    uploadToFirebase();
  }
  delay(10);
}
