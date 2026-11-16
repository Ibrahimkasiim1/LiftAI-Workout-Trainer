import AVFoundation
import ExpoModulesCore

/**
 * LiftDepthCamera — LiDAR-backed meal capture.
 *
 * `isLiDARAvailable()` reports whether the device has a rear LiDAR scanner
 * (iPhone 12 Pro and later Pro/Pro Max; iOS 15.4+ API). `captureMeal()`
 * presents a native full-screen camera (its own AVCaptureSession — this flow
 * deliberately does NOT run through expo-camera) and resolves with the JPEG
 * path plus depth-derived scale metadata, or nil when the user cancels.
 *
 * The depth payload is intentionally small: the subject distance and the
 * real-world width the image spans at that distance. That single scale fact
 * is what removes the vision model's biggest error source (scale ambiguity);
 * a coarse depth grid rides along for future on-device volume work.
 */
public class LiftDepthCameraModule: Module {
  public func definition() -> ModuleDefinition {
    Name("LiftDepthCamera")

    Function("isLiDARAvailable") { () -> Bool in
      guard #available(iOS 15.4, *) else { return false }
      return AVCaptureDevice.default(.builtInLiDARDepthCamera, for: .video, position: .back) != nil
    }

    AsyncFunction("captureMeal") { (promise: Promise) in
      DispatchQueue.main.async {
        guard #available(iOS 15.4, *) else {
          promise.resolve(nil)
          return
        }
        guard AVCaptureDevice.default(.builtInLiDARDepthCamera, for: .video, position: .back) != nil else {
          promise.resolve(nil)
          return
        }
        guard let presenter = Self.topViewController() else {
          promise.reject("no_view_controller", "No view controller available to present the camera")
          return
        }
        let controller = DepthCaptureViewController()
        controller.modalPresentationStyle = .fullScreen
        var settled = false
        controller.onComplete = { result in
          guard !settled else { return }
          settled = true
          switch result {
          case .captured(let payload):
            promise.resolve(payload)
          case .cancelled:
            promise.resolve(nil)
          case .failed(let message):
            promise.reject("capture_failed", message)
          }
        }
        presenter.present(controller, animated: true)
      }
    }
  }

  private static func topViewController() -> UIViewController? {
    let window = UIApplication.shared.connectedScenes
      .compactMap { $0 as? UIWindowScene }
      .flatMap { $0.windows }
      .first { $0.isKeyWindow }
    var top = window?.rootViewController
    while let presented = top?.presentedViewController {
      top = presented
    }
    return top
  }
}
