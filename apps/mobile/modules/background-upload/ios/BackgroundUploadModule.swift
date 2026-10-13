import ExpoModulesCore
import UIKit

// One finite background task for the upload runner (D-158). The system decides how long it lasts
// and may grant none. Every task begun here is ended exactly once: by stop(), by a newer start(),
// by the expiration handler or when the module goes away.
private final class ProtectedTask {
  let id: String
  var identifier: UIBackgroundTaskIdentifier = .invalid

  init(id: String) {
    self.id = id
  }

  // True when this call ended the system task.
  func end() -> Bool {
    guard identifier != .invalid else { return false }
    UIApplication.shared.endBackgroundTask(identifier)
    identifier = .invalid
    return true
  }
}

public class BackgroundUploadModule: Module {
  // Read and written on the main queue only.
  private var task: ProtectedTask?

  public func definition() -> ModuleDefinition {
    Name("BackgroundUpload")
    Events("onEnded")

    AsyncFunction("start") { (taskId: String) -> Bool in
      _ = self.task?.end()
      self.task = nil
      let task = ProtectedTask(id: taskId)
      task.identifier = UIApplication.shared.beginBackgroundTask(withName: "MomentLens uploads") {
        [weak self] in
        // Time is up, or the system could not grant the task. Protection ends here without
        // waiting for JavaScript, which then suspends the runner.
        guard task.end() else { return }
        guard let self, self.task === task else { return }
        self.task = nil
        self.sendEvent("onEnded", ["taskId": task.id, "reason": "expired"])
      }
      guard task.identifier != .invalid else { return false }
      self.task = task
      return true
    }.runOnQueue(.main)

    AsyncFunction("stop") { (taskId: String) in
      guard let task = self.task, task.id == taskId else { return }
      self.task = nil
      _ = task.end()
    }.runOnQueue(.main)

    OnDestroy {
      // A reload drops this module. Its task must still end, or the system kills the app when the
      // time runs out.
      let task = self.task
      self.task = nil
      DispatchQueue.main.async {
        _ = task?.end()
      }
    }
  }
}
