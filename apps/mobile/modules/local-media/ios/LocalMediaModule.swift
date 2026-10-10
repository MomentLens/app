import ExpoModulesCore
import Foundation
import AVFoundation

public class LocalMediaModule: Module {
  public func definition() -> ModuleDefinition {
    Name("LocalMedia")
    AsyncFunction("cameraStillSize") { (front: Bool) -> String in
      let position: AVCaptureDevice.Position = front ? .front : .back
      guard let device = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: position) else {
        throw NSError(domain: "LocalMedia", code: 3)
      }
      let dimensions = device.activeFormat.highResolutionStillImageDimensions
      guard dimensions.width > 0 && dimensions.height > 0 else {
        throw NSError(domain: "LocalMedia", code: 4)
      }
      return "\(dimensions.width)x\(dimensions.height)"
    }
    AsyncFunction("excludeMediaFromBackup") { () -> Bool in
      let manager = FileManager.default
      guard let documents = manager.urls(for: .documentDirectory, in: .userDomainMask).first else {
        throw NSError(domain: "LocalMedia", code: 1)
      }
      // Excluding the database directory covers its WAL and SHM files too.
      for path in ["upload-queue", "SQLite"] {
        var directory = documents.appendingPathComponent(path, isDirectory: true)
        try manager.createDirectory(at: directory, withIntermediateDirectories: true)
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try directory.setResourceValues(values)
        guard try directory.resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup == true else {
          throw NSError(domain: "LocalMedia", code: 2)
        }
      }
      return true
    }
  }
}
