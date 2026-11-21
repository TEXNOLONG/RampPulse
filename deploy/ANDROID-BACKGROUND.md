# Android push and background calls

RampPulse sends app notifications through Firebase Cloud Messaging (FCM). The Rust service stores device tokens, persists a ringing call for 90 seconds, and sends high-priority data messages for calls, new requests, and chat. Android opens RampPulse from the notification; once authenticated, the app restores the pending call from the Rust API. Active calls use an Android microphone foreground service so the process is less likely to be suspended when the user switches apps.

## Enable FCM for the Android APK

1. In Firebase Console, create a Firebase project and add an Android application using the exact `applicationId` shown in `src-tauri/gen/android/app/build.gradle.kts` after `npm run android:prepare`.
2. Download that application's `google-services.json` to `src-tauri/android/google-services.json`. This file is intentionally ignored by Git. The Android preparation script copies it into the generated Gradle app, adds Firebase Messaging and generates the notification and call-service classes.
3. Re-run `npm run android:prepare` and build the APK with the existing `npm run android:build` command.
4. In Firebase project settings, create a service account with Firebase Cloud Messaging permissions and download its private JSON key. Upload it to the VPS as `/etc/ramppulse/firebase-service-account.json`; set owner `root:ramppulse` and mode `0640`.

## Enable server delivery on the VPS

Create `/etc/ramppulse/fcm.env` on the VPS (do not put the private key in the project or APK):

```ini
GOOGLE_APPLICATION_CREDENTIALS=/etc/ramppulse/firebase-service-account.json
```

The Rust systemd unit loads this optional environment file. After uploading the new server binary, run:

```sh
sudo systemctl restart ramppulse-server
sudo journalctl -u ramppulse-server -n 100 --no-pager
```

Without the service-account file, the app and server still build and work in the foreground, but no Android push notifications are sent. After the APK is installed and the engineer signs in, Android asks for notification permission and registers its FCM token against that account.

## On the phone

Allow RampPulse notifications and microphone access. For reliable background ringing on Samsung, set RampPulse battery usage to **Unrestricted** and allow background data. A foreground-call notification remains visible during an active call; the call still needs network connectivity and microphone permission.

## Attachments

Chat uploads now allow files up to 100 MiB and common images, audio/video, text/data, office documents, and archive formats. The limit applies per file and is enforced by both HTTP body parsing and the SQLite schema.
