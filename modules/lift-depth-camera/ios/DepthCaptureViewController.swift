import AVFoundation
import UIKit

/**
 * Full-screen native camera for meal capture on LiDAR devices.
 *
 * Runs its own AVCaptureSession on the `.builtInLiDARDepthCamera` device with
 * depth data delivery enabled on the photo output. On capture it writes the
 * JPEG to a temp file and reduces the AVDepthData to:
 *   - subjectDistanceCm: median LiDAR distance over the center of the frame
 *   - fieldWidthCm: real-world width the full image spans at that distance
 *     (from calibration intrinsics when present, else the lens field of view)
 *   - grid: a coarse row-major Float depth grid (16x12, meters, -1 invalid)
 *
 * UI is deliberately minimal: preview, hint ("aim straight down"), a LiDAR
 * badge, shutter, and cancel. Flash/zoom stay out of v1 — depth quality is
 * best with a steady top-down shot at roughly 30-45 cm.
 */
@available(iOS 15.4, *)
final class DepthCaptureViewController: UIViewController {
  enum CaptureResult {
    case captured([String: Any])
    case cancelled
    case failed(String)
  }

  var onComplete: ((CaptureResult) -> Void)?

  private let session = AVCaptureSession()
  private let photoOutput = AVCapturePhotoOutput()
  private let sessionQueue = DispatchQueue(label: "com.example.liftai.depthcamera.session")
  private var previewLayer: AVCaptureVideoPreviewLayer?
  private var horizontalFOVDegrees: Double = 0
  private var isCapturing = false
  private var didFinish = false

  private let shutterButton = UIButton(type: .custom)
  private let cancelButton = UIButton(type: .system)
  private let hintLabel = UILabel()
  private let badgeLabel = UILabel()

  // MARK: - Lifecycle

  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = .black
    buildUI()

    switch AVCaptureDevice.authorizationStatus(for: .video) {
    case .authorized:
      configureAndStart()
    case .notDetermined:
      AVCaptureDevice.requestAccess(for: .video) { [weak self] granted in
        DispatchQueue.main.async {
          granted ? self?.configureAndStart() : self?.finish(.failed("camera_permission_denied"))
        }
      }
    default:
      finish(.failed("camera_permission_denied"))
    }
  }

  override func viewDidLayoutSubviews() {
    super.viewDidLayoutSubviews()
    previewLayer?.frame = view.bounds
  }

  override var prefersStatusBarHidden: Bool { true }
  override var supportedInterfaceOrientations: UIInterfaceOrientationMask { .portrait }

  // MARK: - Session

  private func configureAndStart() {
    sessionQueue.async { [weak self] in
      guard let self else { return }
      self.session.beginConfiguration()
      self.session.sessionPreset = .photo

      guard
        let device = AVCaptureDevice.default(.builtInLiDARDepthCamera, for: .video, position: .back),
        let input = try? AVCaptureDeviceInput(device: device),
        self.session.canAddInput(input)
      else {
        self.session.commitConfiguration()
        DispatchQueue.main.async { self.finish(.failed("lidar_device_unavailable")) }
        return
      }
      self.session.addInput(input)
      self.horizontalFOVDegrees = Double(device.activeFormat.videoFieldOfView)

      guard self.session.canAddOutput(self.photoOutput) else {
        self.session.commitConfiguration()
        DispatchQueue.main.async { self.finish(.failed("photo_output_unavailable")) }
        return
      }
      self.session.addOutput(self.photoOutput)
      self.photoOutput.isDepthDataDeliveryEnabled = self.photoOutput.isDepthDataDeliverySupported
      self.session.commitConfiguration()
      self.session.startRunning()

      DispatchQueue.main.async { self.attachPreview() }
    }
  }

  private func attachPreview() {
    guard previewLayer == nil else { return }
    let layer = AVCaptureVideoPreviewLayer(session: session)
    layer.videoGravity = .resizeAspectFill
    layer.frame = view.bounds
    view.layer.insertSublayer(layer, at: 0)
    previewLayer = layer
  }

  // MARK: - UI

  private func buildUI() {
    hintLabel.text = "Aim straight down at your plate"
    hintLabel.textColor = UIColor(white: 1, alpha: 0.92)
    hintLabel.font = .systemFont(ofSize: 13, weight: .semibold)
    hintLabel.textAlignment = .center
    hintLabel.backgroundColor = UIColor(white: 0, alpha: 0.55)
    hintLabel.layer.cornerRadius = 14
    hintLabel.layer.masksToBounds = true

    badgeLabel.text = "  LiDAR DEPTH ON  "
    badgeLabel.textColor = UIColor(red: 0.35, green: 0.65, blue: 1.0, alpha: 1)
    badgeLabel.font = .systemFont(ofSize: 10, weight: .bold)
    badgeLabel.backgroundColor = UIColor(white: 0, alpha: 0.55)
    badgeLabel.layer.cornerRadius = 9
    badgeLabel.layer.masksToBounds = true

    shutterButton.backgroundColor = .white
    shutterButton.layer.cornerRadius = 37
    shutterButton.layer.borderWidth = 4
    shutterButton.layer.borderColor = UIColor(white: 1, alpha: 0.35).cgColor
    shutterButton.addTarget(self, action: #selector(shutterTapped), for: .touchUpInside)

    cancelButton.setImage(UIImage(systemName: "xmark"), for: .normal)
    cancelButton.tintColor = .white
    cancelButton.addTarget(self, action: #selector(cancelTapped), for: .touchUpInside)

    for control in [hintLabel, badgeLabel, shutterButton, cancelButton] {
      control.translatesAutoresizingMaskIntoConstraints = false
      view.addSubview(control)
    }

    let safe = view.safeAreaLayoutGuide
    NSLayoutConstraint.activate([
      cancelButton.topAnchor.constraint(equalTo: safe.topAnchor, constant: 12),
      cancelButton.leadingAnchor.constraint(equalTo: safe.leadingAnchor, constant: 16),
      cancelButton.widthAnchor.constraint(equalToConstant: 36),
      cancelButton.heightAnchor.constraint(equalToConstant: 36),

      badgeLabel.centerXAnchor.constraint(equalTo: view.centerXAnchor),
      badgeLabel.topAnchor.constraint(equalTo: safe.topAnchor, constant: 18),
      badgeLabel.heightAnchor.constraint(equalToConstant: 18),

      hintLabel.centerXAnchor.constraint(equalTo: view.centerXAnchor),
      hintLabel.topAnchor.constraint(equalTo: badgeLabel.bottomAnchor, constant: 10),
      hintLabel.widthAnchor.constraint(equalToConstant: 260),
      hintLabel.heightAnchor.constraint(equalToConstant: 28),

      shutterButton.centerXAnchor.constraint(equalTo: view.centerXAnchor),
      shutterButton.bottomAnchor.constraint(equalTo: safe.bottomAnchor, constant: -24),
      shutterButton.widthAnchor.constraint(equalToConstant: 74),
      shutterButton.heightAnchor.constraint(equalToConstant: 74),
    ])
  }

  // MARK: - Actions

  @objc private func cancelTapped() {
    finish(.cancelled)
  }

  @objc private func shutterTapped() {
    guard !isCapturing else { return }
    isCapturing = true
    shutterButton.alpha = 0.5

    sessionQueue.async { [weak self] in
      guard let self else { return }
      let settings = AVCapturePhotoSettings(format: [AVVideoCodecKey: AVVideoCodecType.jpeg])
      if self.photoOutput.isDepthDataDeliverySupported {
        settings.isDepthDataDeliveryEnabled = true
        // Raw (unfiltered) depth keeps real measurements; filtering inpaints
        // holes with guesses, which is wrong for measurement use.
        settings.isDepthDataFiltered = false
        settings.embedsDepthDataInPhoto = false
      }
      self.photoOutput.capturePhoto(with: settings, delegate: self)
    }
  }

  private func finish(_ result: CaptureResult) {
    guard !didFinish else { return }
    didFinish = true
    sessionQueue.async { [weak self] in
      if self?.session.isRunning == true { self?.session.stopRunning() }
    }
    let complete = onComplete
    dismiss(animated: true) {
      complete?(result)
    }
  }
}

// MARK: - Photo delegate

@available(iOS 15.4, *)
extension DepthCaptureViewController: AVCapturePhotoCaptureDelegate {
  func photoOutput(
    _ output: AVCapturePhotoOutput,
    didFinishProcessingPhoto photo: AVCapturePhoto,
    error: Error?
  ) {
    if let error {
      DispatchQueue.main.async { self.finish(.failed(error.localizedDescription)) }
      return
    }
    guard let jpegData = photo.fileDataRepresentation() else {
      DispatchQueue.main.async { self.finish(.failed("no_photo_data")) }
      return
    }

    let fileURL = URL(fileURLWithPath: NSTemporaryDirectory())
      .appendingPathComponent("meal-\(UUID().uuidString).jpg")
    do {
      try jpegData.write(to: fileURL)
    } catch {
      DispatchQueue.main.async { self.finish(.failed("photo_write_failed")) }
      return
    }

    let dimensions = photo.resolvedSettings.photoDimensions
    var payload: [String: Any] = [
      "uri": fileURL.absoluteString,
      "width": Int(dimensions.width),
      "height": Int(dimensions.height),
    ]
    if let depthData = photo.depthData,
       let depth = Self.depthPayload(from: depthData, fovDegrees: horizontalFOVDegrees) {
      payload["depth"] = depth
    } else {
      payload["depth"] = NSNull()
    }

    DispatchQueue.main.async { self.finish(.captured(payload)) }
  }

  /// Reduce the depth map to scale metadata + a coarse grid.
  private static func depthPayload(from depthData: AVDepthData, fovDegrees: Double) -> [String: Any]? {
    let converted: AVDepthData
    if depthData.depthDataType != kCVPixelFormatType_DepthFloat32 {
      guard let c = try? depthData.converting(toDepthDataType: kCVPixelFormatType_DepthFloat32) else {
        return nil
      }
      converted = c
    } else {
      converted = depthData
    }

    let map = converted.depthDataMap
    CVPixelBufferLockBaseAddress(map, .readOnly)
    defer { CVPixelBufferUnlockBaseAddress(map, .readOnly) }

    let width = CVPixelBufferGetWidth(map)
    let height = CVPixelBufferGetHeight(map)
    guard width > 0, height > 0, let base = CVPixelBufferGetBaseAddress(map) else { return nil }
    let rowBytes = CVPixelBufferGetBytesPerRow(map)

    func depthAt(_ x: Int, _ y: Int) -> Float {
      let row = base.advanced(by: y * rowBytes).assumingMemoryBound(to: Float32.self)
      return row[x]
    }

    // Median distance over the center 40% of the frame — that's where the
    // plate is in a framed shot; edges catch the table and the user's arm.
    var samples: [Float] = []
    samples.reserveCapacity(1024)
    let x0 = Int(Double(width) * 0.3), x1 = Int(Double(width) * 0.7)
    let y0 = Int(Double(height) * 0.3), y1 = Int(Double(height) * 0.7)
    let stride = max(1, (x1 - x0) / 32)
    var y = y0
    while y < y1 {
      var x = x0
      while x < x1 {
        let d = depthAt(x, y)
        if d.isFinite && d > 0.05 && d < 5.0 { samples.append(d) }
        x += stride
      }
      y += stride
    }
    guard samples.count >= 16 else { return nil }
    samples.sort()
    let distanceM = Double(samples[samples.count / 2])

    // Real-world width of the full frame at the food's distance. Prefer the
    // calibration intrinsics (exact); fall back to the lens field of view.
    var fieldWidthM: Double? = nil
    if let calibration = converted.cameraCalibrationData {
      let fx = Double(calibration.intrinsicMatrix.columns.0.x)
      let refWidth = Double(calibration.intrinsicMatrixReferenceDimensions.width)
      if fx > 0, refWidth > 0 {
        fieldWidthM = distanceM * refWidth / fx
      }
    }
    if fieldWidthM == nil, fovDegrees > 0 {
      fieldWidthM = 2.0 * distanceM * tan(fovDegrees * .pi / 360.0)
    }

    // Coarse 16x12 grid for future volume estimation (meters, -1 = no data).
    let gridCols = 16, gridRows = 12
    var grid: [Double] = []
    grid.reserveCapacity(gridCols * gridRows)
    for gy in 0..<gridRows {
      for gx in 0..<gridCols {
        let px = min(width - 1, Int((Double(gx) + 0.5) / Double(gridCols) * Double(width)))
        let py = min(height - 1, Int((Double(gy) + 0.5) / Double(gridRows) * Double(height)))
        let d = depthAt(px, py)
        grid.append(d.isFinite && d > 0.05 && d < 5.0 ? Double(d) : -1)
      }
    }

    var result: [String: Any] = [
      "lidar": true,
      "subjectDistanceCm": distanceM * 100.0,
      "grid": grid,
      "gridCols": gridCols,
      "gridRows": gridRows,
    ]
    if let fieldWidthM {
      result["fieldWidthCm"] = fieldWidthM * 100.0
    } else {
      result["fieldWidthCm"] = NSNull()
    }
    return result
  }
}
