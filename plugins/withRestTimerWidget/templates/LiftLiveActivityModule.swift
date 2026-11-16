import ActivityKit
import Foundation
import ImageIO
import React
import UIKit

@objc(LiftLiveActivityModule)
final class LiftLiveActivityModule: RCTEventEmitter {
    private static let skipNotificationName = "com.example.liftai.RestTimerSkip"
    private static let appGroupId = "group.com.example.liftai"
    /// Filenames we write are prefixed with this so old frames can be swept.
    private static let framePrefix = "rest_frame_"

    private var currentActivity: Any?
    private var hasListeners = false

    /// Serial chain for every ActivityKit operation (start / update / end /
    /// image apply). RN delivers bridge calls on a serial method queue, but the
    /// previous implementation ran the async ActivityKit work in DETACHED
    /// Tasks, so a `startActivity` still in flight could complete AFTER
    /// `endActivity` and resurrect the Dynamic Island the moment the user left
    /// the workout screen. Chaining guarantees call-order execution.
    private var workChain: Task<Void, Never>?
    private let chainLock = NSLock()

    private func enqueue(_ operation: @escaping () async -> Void) {
        chainLock.lock()
        let previous = workChain
        workChain = Task {
            if let previous = previous { await previous.value }
            await operation()
        }
        chainLock.unlock()
    }

    override init() {
        super.init()
        registerSkipObserver()
        // Best-effort teardown when the user kills the app (swipe-up in the
        // app switcher while the app is foreground/recently active). Without
        // this the OS keeps the Live Activity — and its auto-updating timers —
        // on the island long after the app is gone. Suspended-then-killed apps
        // get no callback; the widget's stale state covers that path.
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(handleWillTerminate),
            name: UIApplication.willTerminateNotification,
            object: nil
        )
    }

    deinit {
        unregisterSkipObserver()
        NotificationCenter.default.removeObserver(self)
    }

    @objc private func handleWillTerminate() {
        guard #available(iOS 16.2, *) else { return }
        let semaphore = DispatchSemaphore(value: 0)
        enqueue {
            for activity in Activity<RestTimerAttributes>.activities {
                await activity.end(activity.content, dismissalPolicy: .immediate)
            }
            semaphore.signal()
        }
        // willTerminate gives us only a moment — wait briefly for the end to
        // land, then let the process die either way.
        _ = semaphore.wait(timeout: .now() + 1.5)
    }

    /// Phase-aware stale horizon. If the app dies without ending the activity,
    /// the widget flips to its dimmed "Paused" state at this date instead of
    /// counting forever:
    ///  - resting: shortly after the rest would have ended (a live app always
    ///    sends a work-phase update when rest finishes),
    ///  - working: 30 minutes (a live app updates every set — minutes apart).
    private static func staleDate(isResting: Bool, restEndTime: Date?) -> Date {
        if isResting, let end = restEndTime {
            return end.addingTimeInterval(120)
        }
        return Date().addingTimeInterval(30 * 60)
    }

    @objc override static func requiresMainQueueSetup() -> Bool { false }

    override func supportedEvents() -> [String] { ["RestTimerSkipRequested"] }

    override func startObserving() { hasListeners = true }
    override func stopObserving() { hasListeners = false }

    @objc(areActivitiesEnabled:rejecter:)
    func areActivitiesEnabled(
        _ resolve: @escaping RCTPromiseResolveBlock,
        rejecter reject: @escaping RCTPromiseRejectBlock
    ) {
        if #available(iOS 16.2, *) {
            resolve(ActivityAuthorizationInfo().areActivitiesEnabled)
        } else {
            resolve(false)
        }
    }

    @objc(startActivity:resolver:rejecter:)
    func startActivity(
        _ params: NSDictionary,
        resolver resolve: @escaping RCTPromiseResolveBlock,
        rejecter reject: @escaping RCTPromiseRejectBlock
    ) {
        guard #available(iOS 16.2, *) else {
            reject("unsupported", "Live Activities require iOS 16.2 or newer", nil)
            return
        }
        guard ActivityAuthorizationInfo().areActivitiesEnabled else {
            reject("disabled", "Live Activities are disabled in Settings", nil)
            return
        }

        let exerciseName = params["exerciseName"] as? String ?? ""
        let workoutName = params["workoutName"] as? String ?? "LiftAI Workout"
        let setNumber = (params["setNumber"] as? NSNumber)?.intValue ?? 1
        let totalSets = (params["totalSets"] as? NSNumber)?.intValue ?? 1
        let exerciseIndex = (params["exerciseIndex"] as? NSNumber)?.intValue ?? 0
        let totalExercises = (params["totalExercises"] as? NSNumber)?.intValue ?? 0
        let isResting = (params["isResting"] as? NSNumber)?.boolValue ?? false
        let endTimeMs = (params["endTimeMs"] as? NSNumber)?.doubleValue ?? 0
        let workoutStartMs = (params["workoutStartMs"] as? NSNumber)?.doubleValue ?? 0
        let gifUrl = params["gifUrl"] as? String

        enqueue { [weak self] in
            guard let self = self else {
                resolve(nil)
                return
            }

            // Reuse a live activity that is already running: updating in place
            // keeps the Dynamic Island from flashing out/in on phase changes.
            let existing = Activity<RestTimerAttributes>.activities.first { $0.activityState == .active }
            let prev = existing?.content.state

            let workoutStartTime: Date = workoutStartMs > 0
                ? Date(timeIntervalSince1970: workoutStartMs / 1000.0)
                : (prev?.workoutStartTime ?? Date())
            let restEndTime: Date? = (isResting && endTimeMs > 0)
                ? Date(timeIntervalSince1970: endTimeMs / 1000.0)
                : nil
            // Anchor the rest progress bar: keep the original start when we're
            // re-syncing mid-rest, otherwise the rest begins now.
            let restStartTime: Date? = isResting
                ? ((prev?.isResting == true ? prev?.restStartTime : nil) ?? Date())
                : nil
            // Keep the current thumb when the exercise hasn't changed so the
            // image doesn't blink away while a redundant download would run.
            let imageName: String? = (prev?.exerciseName == exerciseName) ? prev?.imageName : nil

            let state = RestTimerAttributes.ContentState(
                exerciseName: exerciseName,
                workoutName: workoutName,
                setNumber: setNumber,
                totalSets: totalSets,
                exerciseIndex: exerciseIndex,
                totalExercises: totalExercises,
                isResting: isResting,
                restStartTime: restStartTime,
                restEndTime: restEndTime,
                workoutStartTime: workoutStartTime,
                imageName: imageName
            )
            let stale = Self.staleDate(isResting: isResting, restEndTime: restEndTime)

            if let existing = existing {
                // End any duplicate stragglers from previous app runs.
                for extra in Activity<RestTimerAttributes>.activities where extra.id != existing.id {
                    await extra.end(extra.content, dismissalPolicy: .immediate)
                }
                self.currentActivity = existing
                await existing.update(.init(state: state, staleDate: stale))
                resolve(existing.id)

                if imageName == nil, let gifUrl = gifUrl, !gifUrl.isEmpty {
                    self.downloadFrame(from: gifUrl) { [weak self] filename in
                        guard let self = self, let filename = filename else { return }
                        self.applyImage(filename, to: existing)
                    }
                }
                return
            }

            self.sweepOldFrames()

            do {
                let activity = try Activity.request(
                    attributes: RestTimerAttributes(),
                    content: .init(state: state, staleDate: stale),
                    pushType: nil
                )
                self.currentActivity = activity
                resolve(activity.id)

                // Fetch the exercise frame off the main path; update the live
                // activity once the image is on disk in the shared container.
                if let gifUrl = gifUrl, !gifUrl.isEmpty {
                    self.downloadFrame(from: gifUrl) { [weak self] filename in
                        guard let self = self, let filename = filename else { return }
                        self.applyImage(filename, to: activity)
                    }
                }
            } catch {
                reject("start_failed", error.localizedDescription, error)
            }
        }
    }

    @objc(updateActivity:resolver:rejecter:)
    func updateActivity(
        _ params: NSDictionary,
        resolver resolve: @escaping RCTPromiseResolveBlock,
        rejecter reject: @escaping RCTPromiseRejectBlock
    ) {
        guard #available(iOS 16.2, *) else {
            resolve(false)
            return
        }

        enqueue { [weak self] in
            guard
                let self = self,
                let activity = self.currentActivity as? Activity<RestTimerAttributes>,
                activity.activityState == .active
            else {
                resolve(false)
                return
            }

            let prev = activity.content.state
            let newIsResting = (params["isResting"] as? NSNumber)?.boolValue ?? prev.isResting
            let newRestEnd: Date? = {
                guard newIsResting else { return nil }
                if let endTimeMs = (params["endTimeMs"] as? NSNumber)?.doubleValue, endTimeMs > 0 {
                    return Date(timeIntervalSince1970: endTimeMs / 1000.0)
                }
                return prev.restEndTime
            }()
            let newRestStart: Date? = newIsResting
                ? ((prev.isResting ? prev.restStartTime : nil) ?? Date())
                : nil
            let newWorkoutStart: Date = {
                if let ms = (params["workoutStartMs"] as? NSNumber)?.doubleValue, ms > 0 {
                    return Date(timeIntervalSince1970: ms / 1000.0)
                }
                return prev.workoutStartTime
            }()

            let newState = RestTimerAttributes.ContentState(
                exerciseName: (params["exerciseName"] as? String) ?? prev.exerciseName,
                workoutName: (params["workoutName"] as? String) ?? prev.workoutName,
                setNumber: ((params["setNumber"] as? NSNumber)?.intValue) ?? prev.setNumber,
                totalSets: ((params["totalSets"] as? NSNumber)?.intValue) ?? prev.totalSets,
                exerciseIndex: ((params["exerciseIndex"] as? NSNumber)?.intValue) ?? prev.exerciseIndex,
                totalExercises: ((params["totalExercises"] as? NSNumber)?.intValue) ?? prev.totalExercises,
                isResting: newIsResting,
                restStartTime: newRestStart,
                restEndTime: newRestEnd,
                workoutStartTime: newWorkoutStart,
                imageName: prev.imageName
            )

            await activity.update(
                .init(
                    state: newState,
                    staleDate: Self.staleDate(isResting: newIsResting, restEndTime: newRestEnd)
                )
            )
            resolve(true)

            // If the caller swapped in a new exercise GIF, refresh the frame too.
            if let gifUrl = params["gifUrl"] as? String, !gifUrl.isEmpty {
                self.downloadFrame(from: gifUrl) { [weak self] filename in
                    guard let self = self, let filename = filename else { return }
                    self.applyImage(filename, to: activity)
                }
            }
        }
    }

    @objc(endActivity:rejecter:)
    func endActivity(
        _ resolve: @escaping RCTPromiseResolveBlock,
        rejecter reject: @escaping RCTPromiseRejectBlock
    ) {
        guard #available(iOS 16.2, *) else {
            resolve(false)
            return
        }
        enqueue { [weak self] in
            // End every activity of our type — including stragglers from
            // previous app runs — not just the one we track.
            for activity in Activity<RestTimerAttributes>.activities {
                await activity.end(activity.content, dismissalPolicy: .immediate)
            }
            self?.currentActivity = nil
            self?.sweepOldFrames()
            resolve(true)
        }
    }

    // MARK: - Exercise frame handling

    /// Re-issue the activity state with the downloaded frame attached. Runs on
    /// the serial chain and only touches activities that are still active, so
    /// a slow image download can never write to (or outlive) an ended island.
    @available(iOS 16.2, *)
    private func applyImage(_ filename: String, to activity: Activity<RestTimerAttributes>) {
        enqueue {
            guard activity.activityState == .active else { return }
            var newState = activity.content.state
            newState.imageName = filename
            await activity.update(
                .init(
                    state: newState,
                    staleDate: Self.staleDate(
                        isResting: newState.isResting,
                        restEndTime: newState.restEndTime
                    )
                )
            )
        }
    }

    /// The shared App Group container both the app and the widget can read.
    private func sharedContainerURL() -> URL? {
        FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: Self.appGroupId)
    }

    /// Download the (animated) GIF and persist its first frame as a small JPEG
    /// into the shared container. WidgetKit can't animate GIFs, so a crisp first
    /// frame is the right tradeoff. Completion runs on the main queue.
    private func downloadFrame(from urlString: String, completion: @escaping (String?) -> Void) {
        guard let url = URL(string: urlString), let container = sharedContainerURL() else {
            completion(nil)
            return
        }

        let task = URLSession.shared.dataTask(with: url) { data, _, _ in
            guard
                let data = data,
                let source = CGImageSourceCreateWithData(data as CFData, nil),
                let cgImage = CGImageSourceCreateImageAtIndex(source, 0, nil)
            else {
                DispatchQueue.main.async { completion(nil) }
                return
            }

            let image = UIImage(cgImage: cgImage)
            let resized = Self.downscale(image, maxDimension: 160)
            guard let jpeg = resized.jpegData(compressionQuality: 0.85) else {
                DispatchQueue.main.async { completion(nil) }
                return
            }

            let filename = "\(Self.framePrefix)\(Int(Date().timeIntervalSince1970 * 1000)).jpg"
            let dest = container.appendingPathComponent(filename)
            do {
                try jpeg.write(to: dest, options: .atomic)
                DispatchQueue.main.async { completion(filename) }
            } catch {
                DispatchQueue.main.async { completion(nil) }
            }
        }
        task.resume()
    }

    /// Aspect-fit downscale so the widget thumbnail stays light.
    private static func downscale(_ image: UIImage, maxDimension: CGFloat) -> UIImage {
        let size = image.size
        let longest = max(size.width, size.height)
        guard longest > maxDimension else { return image }
        let scale = maxDimension / longest
        let target = CGSize(width: size.width * scale, height: size.height * scale)
        let renderer = UIGraphicsImageRenderer(size: target)
        return renderer.image { _ in
            image.draw(in: CGRect(origin: .zero, size: target))
        }
    }

    /// Remove previously written frames so the container doesn't accumulate.
    private func sweepOldFrames() {
        guard let container = sharedContainerURL() else { return }
        let fm = FileManager.default
        guard let files = try? fm.contentsOfDirectory(
            at: container,
            includingPropertiesForKeys: nil
        ) else { return }
        for file in files where file.lastPathComponent.hasPrefix(Self.framePrefix) {
            try? fm.removeItem(at: file)
        }
    }

    private func registerSkipObserver() {
        let name = Self.skipNotificationName as CFString
        CFNotificationCenterAddObserver(
            CFNotificationCenterGetDarwinNotifyCenter(),
            Unmanaged.passUnretained(self).toOpaque(),
            { (_, observer, _, _, _) in
                guard let observer = observer else { return }
                let module = Unmanaged<LiftLiveActivityModule>.fromOpaque(observer).takeUnretainedValue()
                DispatchQueue.main.async {
                    if module.hasListeners {
                        module.sendEvent(withName: "RestTimerSkipRequested", body: nil)
                    }
                }
            },
            name,
            nil,
            .deliverImmediately
        )
    }

    private func unregisterSkipObserver() {
        CFNotificationCenterRemoveEveryObserver(
            CFNotificationCenterGetDarwinNotifyCenter(),
            Unmanaged.passUnretained(self).toOpaque()
        )
    }
}
