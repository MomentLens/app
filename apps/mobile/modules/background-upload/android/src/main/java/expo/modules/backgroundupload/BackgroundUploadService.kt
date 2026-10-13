package expo.modules.backgroundupload

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import com.facebook.react.ReactApplication
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.ReactContext
import com.facebook.react.jstasks.HeadlessJsTaskConfig
import com.facebook.react.jstasks.HeadlessJsTaskContext
import com.facebook.react.jstasks.HeadlessJsTaskEventListener

// A dataSync foreground service that keeps the existing upload runner going in the background
// (D-158). It runs one Headless JS task, which waits on the coordinator's hold, so React Native
// keeps JavaScript timers running while the app is in the background. The runner does the
// uploading in the app's own JavaScript runtime; this service never starts one.
//
// It ends when the task finishes (the coordinator released its hold), when JavaScript stops it,
// when Android's dataSync time budget runs out, or when the person removes the app's task. It
// returns START_NOT_STICKY, so Android never restarts it after a kill.
class BackgroundUploadService : Service(), HeadlessJsTaskEventListener {
  private var taskId: String? = null
  private var jsTask: Int? = null
  private var tasks: HeadlessJsTaskContext? = null
  private var wakeLock: PowerManager.WakeLock? = null
  // Set once JavaScript has heard why this task ended, so onDestroy does not report it again.
  private var reported = false
  // The start that delivered the current task. Stopping with it leaves the service running when
  // a newer start is already on its way, so an older task's end cannot drop a newer task.
  private var startId = 0

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val id = intent?.getStringExtra(EXTRA_TASK)
    if (id == null) {
      stopSelf()
      return START_NOT_STICKY
    }
    // A newer task replaces the one running here. The coordinator ended that one already.
    finishJsTask()
    this.startId = startId
    taskId = id
    currentTask = id
    reported = false
    try {
      startInForeground()
    } catch (error: Exception) {
      // Android refused the foreground service, for example once the dataSync budget is spent.
      // Uploads go on while the app is open, and My Media says so (D-158).
      endWith("refused")
      return START_NOT_STICKY
    }
    // The app's JavaScript runtime must already exist. Starting one here would upload from a
    // cold start, which D-158 rules out.
    val context = reactContext()
    if (context == null) {
      endWith("refused")
      return START_NOT_STICKY
    }
    try {
      val headless = HeadlessJsTaskContext.getInstance(context)
      headless.addTaskEventListener(this)
      tasks = headless
      val data = Arguments.createMap().apply { putString("taskId", id) }
      // No timeout: the hold decides how long the task lasts. Allowed in the foreground, because
      // the service starts while the app is visible.
      jsTask = headless.startTask(HeadlessJsTaskConfig(TASK_KEY, data, 0L, true))
    } catch (error: Exception) {
      endWith("refused")
      return START_NOT_STICKY
    }
    acquireWakeLock()
    return START_NOT_STICKY
  }

  override fun onHeadlessJsTaskStart(taskId: Int) = Unit

  // The coordinator released its hold: the queue has nothing left that this task can upload.
  override fun onHeadlessJsTaskFinish(taskId: Int) {
    if (taskId != jsTask) return
    jsTask = null
    reported = true
    stopSelfResult(startId)
  }

  // Android 15 and later: the shared six-hour dataSync budget ran out. The service has a few
  // seconds to stop, and must not wait for JavaScript.
  override fun onTimeout(startId: Int, fgsType: Int) {
    endWith("timeout")
  }

  override fun onTaskRemoved(rootIntent: Intent?) {
    endWith("stopped")
  }

  override fun onDestroy() {
    finishJsTask()
    tasks?.removeTaskEventListener(this)
    tasks = null
    wakeLock?.let { if (it.isHeld) it.release() }
    wakeLock = null
    stopForeground(STOP_FOREGROUND_REMOVE)
    val id = taskId
    if (id != null) {
      if (!reported) BackgroundUploadModule.ended(id, "stopped")
      if (currentTask == id) currentTask = null
    }
    super.onDestroy()
  }

  private fun endWith(reason: String) {
    val id = taskId
    if (id != null && !reported) {
      reported = true
      BackgroundUploadModule.ended(id, reason)
    }
    stopSelfResult(startId)
  }

  // Lets React Native pause timers again. The JavaScript hold resolves on its own when the
  // coordinator hears that the task ended.
  private fun finishJsTask() {
    val task = jsTask ?: return
    jsTask = null
    tasks?.finishTask(task)
  }

  private fun reactContext(): ReactContext? =
    (application as? ReactApplication)?.reactHost?.currentReactContext

  private fun acquireWakeLock() {
    if (wakeLock?.isHeld == true) return
    val power = getSystemService(Context.POWER_SERVICE) as PowerManager
    wakeLock =
      power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "MomentLens:uploads").apply {
        setReferenceCounted(false)
        // Never longer than Android's dataSync budget. onDestroy releases it sooner.
        acquire(WAKE_LOCK_MS)
      }
  }

  private fun startInForeground() {
    createChannel(this)
    val notification = notification()
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
    } else {
      startForeground(NOTIFICATION_ID, notification)
    }
  }

  // Generic on purpose: no photo, event name, file path, URL, token, GPS or QR evidence (D-158).
  // Android shows it only when the person allows notifications for the app and this channel.
  private fun notification(): Notification {
    val builder =
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        Notification.Builder(this, CHANNEL_ID)
      } else {
        @Suppress("DEPRECATION") Notification.Builder(this)
      }
    val open =
      packageManager.getLaunchIntentForPackage(packageName)?.let {
        PendingIntent.getActivity(
          this,
          0,
          it,
          PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
      }
    return builder
      .setSmallIcon(smallIcon())
      .setContentTitle("Uploading photos")
      .setCategory(Notification.CATEGORY_PROGRESS)
      .setOngoing(true)
      .setOnlyAlertOnce(true)
      .setShowWhen(false)
      .apply { if (open != null) setContentIntent(open) }
      .build()
  }

  // The monochrome icon expo-notifications' config plugin installs, or the app icon without it.
  private fun smallIcon(): Int {
    val icon =
      try {
        packageManager
          .getApplicationInfo(packageName, PackageManager.GET_META_DATA)
          .metaData
          ?.getInt(ICON_META_DATA, 0) ?: 0
      } catch (error: PackageManager.NameNotFoundException) {
        0
      }
    return if (icon != 0) icon else applicationInfo.icon
  }

  companion object {
    const val EXTRA_TASK = "taskId"
    // features/upload-queue/background-task.ts registers this name.
    const val TASK_KEY = "MomentLensBackgroundUpload"
    private const val CHANNEL_ID = "uploads"
    private const val NOTIFICATION_ID = 7314
    private const val ICON_META_DATA = "expo.modules.notifications.default_notification_icon"
    private const val WAKE_LOCK_MS = 6L * 60 * 60 * 1000

    // The task the running service holds, read by the module's stop().
    @Volatile var currentTask: String? = null

    // Creating an existing channel keeps the person's settings for it. Android 13 and later show
    // the notification permission prompt only once a channel exists.
    fun createChannel(context: Context) {
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
      val manager = context.getSystemService(NotificationManager::class.java) ?: return
      val channel =
        NotificationChannel(CHANNEL_ID, "Photo uploads", NotificationManager.IMPORTANCE_LOW).apply {
          description = "Shows while MomentLens uploads your photos."
          setShowBadge(false)
        }
      manager.createNotificationChannel(channel)
    }
  }
}
