import fs from 'node:fs';
import path from 'node:path';

const root = 'src-tauri/gen/android';
const manifestPath = path.join(root, 'app/src/main/AndroidManifest.xml');
if (!fs.existsSync(manifestPath)) throw new Error('Android-проект не создан. Сначала выполните: npm run android:prepare');

const firebaseConfig = 'src-tauri/android/google-services.json';
const hasFirebase = fs.existsSync(firebaseConfig);
const appDir = path.join(root, 'app');
const launcherResources = 'src-tauri/icons/android/res';
if (fs.existsSync(launcherResources)) {
  fs.cpSync(launcherResources, path.join(appDir, 'src/main/res'), { recursive: true, force: true });
}
let manifest = fs.readFileSync(manifestPath, 'utf8');
const permissions = [
  'android.permission.RECORD_AUDIO',
  'android.permission.MODIFY_AUDIO_SETTINGS',
  'android.permission.POST_NOTIFICATIONS',
  'android.permission.ACCESS_COARSE_LOCATION',
  'android.permission.ACCESS_FINE_LOCATION',
  'android.permission.USE_FULL_SCREEN_INTENT',
  'android.permission.FOREGROUND_SERVICE',
  'android.permission.FOREGROUND_SERVICE_MICROPHONE',
];
for (const permission of permissions) {
  if (!manifest.includes(`android:name="${permission}"`)) {
    manifest = manifest.replace(/(<manifest\b[^>]*>)/, `$1\n    <uses-permission android:name="${permission}" />`);
  }
}
if (!manifest.includes('android.hardware.microphone')) {
  manifest = manifest.replace(/(<manifest\b[^>]*>[\s\S]*?)(\s*<application\b)/, '$1\n    <uses-feature android:name="android.hardware.microphone" android:required="false" />$2');
}
if (!manifest.includes('.RampPulseCallService')) {
  manifest = manifest.replace(/(<application\b[^>]*>)/, `$1\n        <service android:name=".RampPulseCallService" android:exported="false" android:foregroundServiceType="microphone" />`);
}
if (hasFirebase) {
  const service = `
        <service android:name=".RampPulseMessagingService" android:exported="false">
            <intent-filter><action android:name="com.google.firebase.MESSAGING_EVENT" /></intent-filter>
        </service>`;
  if (!manifest.includes('.RampPulseMessagingService')) manifest = manifest.replace(/(<application\b[^>]*>)/, `$1${service}`);
  fs.copyFileSync(firebaseConfig, path.join(appDir, 'google-services.json'));
} else {
  manifest = manifest.replace(/\s*<service android:name="\.RampPulseMessagingService"[\s\S]*?<\/service>/, '');
  fs.rmSync(path.join(appDir, 'google-services.json'), { force: true });
}
fs.writeFileSync(manifestPath, manifest);

const activity = path.join(appDir, 'src/main/java');
const findActivity = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
  const current = path.join(dir, entry.name);
  if (entry.isDirectory()) return findActivity(current);
  return entry.name === 'MainActivity.kt' ? [current] : [];
});
const activityFiles = findActivity(activity);
if (!activityFiles.length) throw new Error('Не найден Android MainActivity.kt в сгенерированном проекте.');
const activityFile = activityFiles[0];
const oldActivity = fs.readFileSync(activityFile, 'utf8');
const packageName = oldActivity.match(/^package\s+([\w.]+)/m)?.[1];
if (!packageName) throw new Error('Не удалось определить Android package из MainActivity.kt.');
const packagePath = path.join(activity, ...packageName.split('.'));
fs.mkdirSync(packagePath, { recursive: true });
const notificationIcon = path.join(appDir, 'src/main/res/drawable/ramppulse_notification.xml');
const notificationPng = path.join(appDir, 'src/main/res/drawable-nodpi/ramppulse_notification.png');
fs.mkdirSync(path.dirname(notificationIcon), { recursive: true });
if (fs.existsSync('src-tauri/icons/android/res/drawable-nodpi/ramppulse_notification.png')) {
  fs.copyFileSync('src-tauri/icons/android/res/drawable-nodpi/ramppulse_notification.png', notificationPng);
  fs.rmSync(notificationIcon, { force: true });
} else fs.writeFileSync(notificationIcon, `<?xml version="1.0" encoding="utf-8"?>
<vector xmlns:android="http://schemas.android.com/apk/res/android" android:width="24dp" android:height="24dp" android:viewportWidth="24" android:viewportHeight="24">
    <path android:fillColor="#FFFFFFFF" android:pathData="M12,2.5a9.5,9.5 0,1 0,0 19a9.5,9.5 0,0 0,0 -19M12,4.5a7.5,7.5 0,1 1,0 15a7.5,7.5 0,0 1,0 -15M12,6.2a0.8,0.8 0,0 0,-0.8 0.8v4.5l-2.8,2.1a0.8,0.8 0,1 0,1 1.3l3.1,-2.4a0.8,0.8 0,0 0,0.3 -0.6V7a0.8,0.8 0,0 0,-0.8 -0.8" />
</vector>
`);

const activitySource = `package ${packageName}

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.core.app.ActivityCompat
import androidx.core.app.NotificationManagerCompat
import io.livekit.android.LiveKit
import io.livekit.android.room.Room
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import org.json.JSONObject
${hasFirebase ? 'import com.google.firebase.messaging.FirebaseMessaging' : ''}

class MainActivity : TauriActivity() {
    private val callScope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private var callWebView: WebView? = null
    private var liveKitRoom: Room? = null
    private var pendingCall: Pair<String, String>? = null

    override fun onWebViewCreate(webView: WebView) {
        super.onWebViewCreate(webView)
        callWebView = webView
        android.webkit.CookieManager.getInstance().setAcceptThirdPartyCookies(webView, true)
        webView.addJavascriptInterface(RampPulseNativeBridge(this), "RampPulseAndroid")
        ${hasFirebase ? 'FirebaseMessaging.getInstance().token.addOnSuccessListener { RampPulsePushStore.save(this, it) }' : ''}
    }

    fun connectLiveKit(url: String, token: String) = runOnUiThread {
        if (ActivityCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            pendingCall = url to token
            ActivityCompat.requestPermissions(this, arrayOf(Manifest.permission.RECORD_AUDIO), 734)
        } else connectLiveKitGranted(url, token)
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, results: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, results)
        if (requestCode != 734) return
        val call = pendingCall
        pendingCall = null
        if (results.firstOrNull() == PackageManager.PERMISSION_GRANTED && call != null) connectLiveKitGranted(call.first, call.second)
        else dispatchCall("error", "Разреши RampPulse доступ к микрофону для звонков")
    }

    private fun connectLiveKitGranted(url: String, token: String) {
        val service = android.content.Intent(this, RampPulseCallService::class.java)
        if (Build.VERSION.SDK_INT >= 26) startForegroundService(service) else startService(service)
        callScope.launch {
            try {
                liveKitRoom?.disconnect()
                val nextRoom = LiveKit.create(applicationContext)
                liveKitRoom = nextRoom
                nextRoom.connect(url, token)
                if (!nextRoom.localParticipant.setMicrophoneEnabled(true)) throw IllegalStateException("Не удалось включить микрофон")
                dispatchCall("connected")
            } catch (error: Throwable) {
                liveKitRoom?.disconnect()
                liveKitRoom = null
                stopService(service)
                dispatchCall("error", error.message ?: "Не удалось подключиться к серверу звонков")
            }
        }
    }

    fun disconnectLiveKit() = runOnUiThread {
        val service = android.content.Intent(this, RampPulseCallService::class.java)
        callScope.launch {
            try { liveKitRoom?.disconnect() } catch (_: Throwable) { }
            liveKitRoom = null
            stopService(service)
        }
    }

    fun setCallMuted(muted: Boolean) = runOnUiThread {
        callScope.launch { liveKitRoom?.localParticipant?.setMicrophoneEnabled(!muted) }
    }

    fun dispatchCall(type: String, message: String = "") {
        val detail = JSONObject().put("type", type).put("message", message).toString()
        callWebView?.post { callWebView?.evaluateJavascript("window.dispatchEvent(new CustomEvent('rampulse-native-call',{detail:$detail}))", null) }
    }

    override fun onDestroy() {
        callScope.cancel()
        try { liveKitRoom?.disconnect() } catch (_: Throwable) { }
        liveKitRoom = null
        super.onDestroy()
    }

    override fun onResume() {
        super.onResume()
        getSharedPreferences("ramppulse", MODE_PRIVATE).edit().putBoolean("foreground", true).apply()
    }

    override fun onPause() {
        getSharedPreferences("ramppulse", MODE_PRIVATE).edit().putBoolean("foreground", false).apply()
        super.onPause()
    }
}

class RampPulseNativeBridge(private val activity: MainActivity) {
    @JavascriptInterface fun getPushToken(): String = activity.getSharedPreferences("ramppulse", 0).getString("push_token", "") ?: ""
    @JavascriptInterface fun notificationsEnabled(): Boolean = NotificationManagerCompat.from(activity).areNotificationsEnabled()
    @JavascriptInterface fun requestNotifications() {
        if (Build.VERSION.SDK_INT >= 33 && ActivityCompat.checkSelfPermission(activity, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) { activity.runOnUiThread { ActivityCompat.requestPermissions(activity, arrayOf(Manifest.permission.POST_NOTIFICATIONS), 731) } }
    }
    @JavascriptInterface fun startCall() {
        val intent = android.content.Intent(activity, RampPulseCallService::class.java); if (Build.VERSION.SDK_INT >= 26) activity.startForegroundService(intent) else activity.startService(intent)
    }
    @JavascriptInterface fun stopCall() {
        activity.stopService(android.content.Intent(activity, RampPulseCallService::class.java))
    }
    @JavascriptInterface fun connectLiveKit(url: String, token: String) = activity.connectLiveKit(url, token)
    @JavascriptInterface fun disconnectLiveKit() = activity.disconnectLiveKit()
    @JavascriptInterface fun setCallMuted(muted: Boolean) = activity.setCallMuted(muted)
}
`;
fs.writeFileSync(activityFile, activitySource);

const appGradleKts = path.join(appDir, 'build.gradle.kts');
const appGradle = path.join(appDir, 'build.gradle');
const rootGradleKts = path.join(root, 'build.gradle.kts');
const rootGradle = path.join(root, 'build.gradle');
function addPlugin(pathname, line, applyFalse = false) {
  if (!fs.existsSync(pathname)) return;
  let text = fs.readFileSync(pathname, 'utf8');
  const id = line.match(/id\(["']([^"']+)/)?.[1] ?? line.match(/id ["']([^"']+)/)?.[1];
  if (id && text.includes(id)) return;
  const plugins = /plugins\s*\{/;
  if (plugins.test(text)) text = text.replace(plugins, match => `${match}\n    ${line}`);
  else {
    const isGroovy = pathname.endsWith('.gradle');
    const declaration = applyFalse
      ? `plugins { ${line} }\n`
      : isGroovy ? `apply plugin: '${id}'\n` : `apply(plugin = "${id}")\n`;
    text = `${declaration}${text}`;
  }
  fs.writeFileSync(pathname, text);
}
function addFirebaseDependency(pathname) {
  if (!fs.existsSync(pathname)) return;
  let text = fs.readFileSync(pathname, 'utf8');
  if (text.includes('firebase-messaging')) {
    if (!hasFirebase) text = text.split('\n').filter(line => !line.includes('firebase-messaging')).join('\n');
    fs.writeFileSync(pathname, text); return;
  }
  if (hasFirebase) {
    const isKts = pathname.endsWith('.kts');
    const line = isKts ? '    implementation("com.google.firebase:firebase-messaging:24.1.2")' : "    implementation 'com.google.firebase:firebase-messaging:24.1.2'";
    text = text.replace(/dependencies\s*\{/, match => `${match}\n${line}`);
    fs.writeFileSync(pathname, text);
  }
}

function addLiveKitDependency(pathname) {
  if (!fs.existsSync(pathname)) return;
  let text = fs.readFileSync(pathname, 'utf8');
  if (text.includes('io.livekit:livekit-android')) return;
  const isKts = pathname.endsWith('.kts');
  const line = isKts ? '    implementation("io.livekit:livekit-android:2.30.0")' : "    implementation 'io.livekit:livekit-android:2.30.0'";
  text = text.replace(/dependencies\s*\{/, match => `${match}\n${line}`);
  fs.writeFileSync(pathname, text);
}
function addLiveKitRepository(pathname) {
  if (!fs.existsSync(pathname)) return;
  let text = fs.readFileSync(pathname, 'utf8');
  if (text.includes('jitpack.io')) return;
  const isKts = pathname.endsWith('.kts');
  const repository = isKts
    ? '        maven { url = uri("https://jitpack.io") }'
    : '        maven { url "https://jitpack.io" }';
  text = text.replace(/allprojects\s*\{\s*repositories\s*\{/, match => `${match}\n${repository}`);
  fs.writeFileSync(pathname, text);
}
addLiveKitRepository(path.join(root, 'build.gradle.kts'));
addLiveKitRepository(path.join(root, 'build.gradle'));
fs.writeFileSync(path.join(packagePath, 'RampPulseCallService.kt'), `package ${packageName}

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat

class RampPulseCallService : Service() {
    override fun onBind(intent: Intent?): IBinder? = null
    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val id = "ramppulse_active_call"
        val manager = getSystemService(NotificationManager::class.java)
        if (Build.VERSION.SDK_INT >= 26) manager.createNotificationChannel(NotificationChannel(id, "Активный звонок", NotificationManager.IMPORTANCE_LOW))
        val open = packageManager.getLaunchIntentForPackage(packageName) ?: Intent(this, MainActivity::class.java)
        val pending = PendingIntent.getActivity(this, 732, open, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val notification: Notification = NotificationCompat.Builder(this, id).setSmallIcon(android.R.drawable.stat_sys_phone_call)
            .setContentTitle("Звонок RampPulse активен").setContentText("Связь смены продолжается в фоне")
            .setCategory(NotificationCompat.CATEGORY_CALL).setOngoing(true).setContentIntent(pending).build()
        startForeground(733, notification)
        return START_NOT_STICKY
    }
}
`);

if (hasFirebase) {
  addPlugin(rootGradleKts, 'id("com.google.gms.google-services") version "4.4.2" apply false', true);
  addPlugin(rootGradle, "id 'com.google.gms.google-services' version '4.4.2' apply false", true);
  addPlugin(appGradleKts, 'id("com.google.gms.google-services")');
  addPlugin(appGradle, "id 'com.google.gms.google-services'");
}
for (const pathname of [appGradleKts, appGradle]) {
  addFirebaseDependency(pathname);
  addLiveKitDependency(pathname);
}

if (hasFirebase) {
  fs.writeFileSync(path.join(packagePath, 'RampPulsePushStore.kt'), `package ${packageName}\n\nimport android.content.Context\n\nobject RampPulsePushStore { fun save(context: Context, token: String) { context.getSharedPreferences("ramppulse", 0).edit().putString("push_token", token).apply() } }\n`);
  fs.writeFileSync(path.join(packagePath, 'RampPulseMessagingService.kt'), `package ${packageName}

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Intent
import android.os.Build
import androidx.core.app.NotificationCompat
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage

class RampPulseMessagingService : FirebaseMessagingService() {
    override fun onNewToken(token: String) { RampPulsePushStore.save(this, token) }
    override fun onMessageReceived(message: RemoteMessage) {
        val prefs = getSharedPreferences("ramppulse", 0)
        if (prefs.getBoolean("foreground", false)) return
        val data = message.data
        val kind = data["kind"] ?: "chat"
        val channelId = if (kind == "call") "ramppulse_calls_v2" else "ramppulse_updates_v2"
        val manager = getSystemService(NotificationManager::class.java)
        if (Build.VERSION.SDK_INT >= 26) {
            val importance = if (kind == "call") NotificationManager.IMPORTANCE_HIGH else NotificationManager.IMPORTANCE_DEFAULT
            val channel = NotificationChannel(channelId, if (kind == "call") "Звонки RampPulse" else "События RampPulse", importance)
            if (kind == "call") { channel.enableVibration(true); channel.vibrationPattern = longArrayOf(0, 450, 250, 450); channel.lockscreenVisibility = Notification.VISIBILITY_PRIVATE }
            manager.createNotificationChannel(channel)
        }
        val intent = packageManager.getLaunchIntentForPackage(packageName) ?: Intent(this, MainActivity::class.java)
        intent.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        data.forEach { (key, value) -> intent.putExtra("rp_$key", value) }
        intent.putExtra("rp_opened_from_notification", true)
        val pending = PendingIntent.getActivity(this, (data["call_id"] ?: data["message_id"] ?: System.currentTimeMillis().toString()).hashCode(), intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val notification = NotificationCompat.Builder(this, channelId)
            .setSmallIcon(R.drawable.ramppulse_notification).setContentTitle(data["title"] ?: if (kind == "call") "Входящий вызов RampPulse" else "RampPulse")
            .setContentText(data["body"] ?: "Откройте приложение, чтобы посмотреть")
            .setCategory(if (kind == "call") NotificationCompat.CATEGORY_CALL else NotificationCompat.CATEGORY_MESSAGE)
            .setPriority(if (kind == "call") NotificationCompat.PRIORITY_MAX else NotificationCompat.PRIORITY_DEFAULT)
            .setDefaults(NotificationCompat.DEFAULT_ALL).setAutoCancel(true).setContentIntent(pending)
            .apply { if (kind == "call") { setFullScreenIntent(pending, true); setTimeoutAfter(90_000) } }
            .build()
        manager.notify(pending.hashCode(), notification)
    }
}
`);
} else {
  for (const name of ['RampPulsePushStore.kt', 'RampPulseMessagingService.kt']) fs.rmSync(path.join(packagePath, name), { force: true });
}
console.log(`Android microphone, foreground-call bridge, and notification permissions configured${hasFirebase ? ' with Firebase Messaging' : '; add src-tauri/android/google-services.json to enable Firebase push'}.`);
