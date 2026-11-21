# Assistente IA for Android

The companion app for the Assistente IA portal. It shows live sessions, usage limits and activity, and lets you answer permission requests from Claude Code and Codex.

- **Background notifications**: a foreground service checks the portal every few seconds. Each request arrives as a notification with **Allow once** and **Deny**. On Android 12 and later, Allow requires unlocking the phone.
- **Secure pairing**: scan the code from **Devices** in the portal. The code carries the SHA-256 fingerprint of the portal's certificate, and the app only talks to that exact certificate.
- **Compatibility**: runs on Android 4.4 and newer. The interface is plain ES5 inside a WebView, and newer platform APIs (notification channels, unlock-to-approve) are reached through reflection.

## Build

The app builds without Gradle. You need:
- JDK 17 or newer
- Android SDK build-tools (aapt, d8, zipalign, apksigner)
- the API 19 `android.jar`
- [ZXing core 3.3.3](https://repo1.maven.org/maven2/com/google/zxing/core/3.3.3/core-3.3.3.jar)

```
python build.py --android-jar <sdk>/platforms/android-19/android.jar --build-tools <sdk>/build-tools/35.0.0 \
  --zxing core-3.3.3.jar --keystore my-key.p12 --ks-pass-file my-key-password.txt
```

Create a signing key once with `keytool -genkeypair -keystore my-key.p12 -alias dashboard -keyalg RSA -keysize 2048 -validity 10000`. Keep using the same key: Android installs an update over an existing app only when both are signed with it.

The app targets SDK 33, the highest level this API 19 toolchain can describe in the manifest. To publish the APK in your portal, copy it to `portal/downloads/AssistenteIA-Android.apk`.

Created by Diogo Moreira · MIT License
