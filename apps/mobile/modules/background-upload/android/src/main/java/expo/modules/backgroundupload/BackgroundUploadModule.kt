package expo.modules.backgroundupload

import android.content.Intent
import android.os.Bundle
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.lang.ref.WeakReference

// Starts and stops the upload service for the coordinator in features/upload-queue/background.ts
// (D-158). Only a task id crosses in from JavaScript.
class BackgroundUploadModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("BackgroundUpload")
    Events("onEnded")

    OnCreate {
      current = WeakReference(this@BackgroundUploadModule)
    }

    OnDestroy {
      if (current?.get() === this@BackgroundUploadModule) current = null
    }

    // Called only while the app is visible, which is when Android lets an app start a foreground
    // service. True once the start was accepted; a refusal inside the service arrives as onEnded.
    AsyncFunction("start") { taskId: String ->
      val context = appContext.reactContext ?: return@AsyncFunction false
      BackgroundUploadService.createChannel(context)
      val intent =
        Intent(context, BackgroundUploadService::class.java)
          .putExtra(BackgroundUploadService.EXTRA_TASK, taskId)
      try {
        context.startService(intent) != null
      } catch (error: IllegalStateException) {
        // The app was no longer in the foreground.
        false
      } catch (error: SecurityException) {
        false
      }
    }.runOnQueue(Queues.MAIN)

    // Stops the service only while it still runs this task, so an older task's stop cannot end
    // a newer one.
    AsyncFunction("stop") { taskId: String ->
      val context = appContext.reactContext ?: return@AsyncFunction
      if (BackgroundUploadService.currentTask == taskId) {
        context.stopService(Intent(context, BackgroundUploadService::class.java))
      }
    }.runOnQueue(Queues.MAIN)
  }

  private fun ended(taskId: String, reason: String) {
    sendEvent(
      "onEnded",
      Bundle().apply {
        putString("taskId", taskId)
        putString("reason", reason)
      },
    )
  }

  companion object {
    @Volatile private var current: WeakReference<BackgroundUploadModule>? = null

    // The service ended a task without JavaScript asking: a refusal, a timeout or a shutdown.
    fun ended(taskId: String, reason: String) {
      current?.get()?.ended(taskId, reason)
    }
  }
}
