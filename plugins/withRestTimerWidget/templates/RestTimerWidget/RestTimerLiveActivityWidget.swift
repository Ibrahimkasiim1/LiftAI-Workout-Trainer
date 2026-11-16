import ActivityKit
import SwiftUI
import UIKit
import WidgetKit

private let restWidgetAppGroupId = "group.com.example.liftai"
/// LiftAI brand blue (#2E90FA) — accent for timers, progress and actions.
private let brandBlue = Color(red: 46 / 255, green: 144 / 255, blue: 250 / 255)

/// Load a previously-downloaded exercise frame from the shared App Group
/// container. Returns nil when the frame hasn't been written yet (the widget
/// then falls back to an SF Symbol so layout never collapses).
@available(iOS 16.2, *)
private func loadExerciseFrame(_ imageName: String?) -> UIImage? {
    guard
        let imageName = imageName,
        let container = FileManager.default.containerURL(
            forSecurityApplicationGroupIdentifier: restWidgetAppGroupId
        )
    else { return nil }
    let url = container.appendingPathComponent(imageName)
    return UIImage(contentsOfFile: url.path)
}

@available(iOS 16.2, *)
struct ExerciseThumb: View {
    let imageName: String?
    var size: CGFloat = 44

    var body: some View {
        Group {
            if let frame = loadExerciseFrame(imageName) {
                Image(uiImage: frame)
                    .resizable()
                    .aspectRatio(contentMode: .fill)
            } else {
                Image(systemName: "figure.strengthtraining.traditional")
                    .font(.system(size: size * 0.45, weight: .medium))
                    .foregroundStyle(.secondary)
            }
        }
        .frame(width: size, height: size)
        .background(Color.primary.opacity(0.08))
        .clipShape(RoundedRectangle(cornerRadius: size * 0.24, style: .continuous))
    }
}

// MARK: - Presentation helpers

@available(iOS 16.2, *)
private extension RestTimerAttributes.ContentState {
    var setLine: String { "SET \(setNumber) OF \(totalSets)" }

    var exerciseLine: String? {
        guard totalExercises > 0, exerciseIndex > 0 else { return nil }
        return "EXERCISE \(exerciseIndex) OF \(totalExercises)"
    }

    /// Context line above the exercise name, e.g. "REST · SET 2 OF 4" while
    /// resting or "SET 2 OF 4 · EXERCISE 1 OF 6" while lifting.
    var contextLine: String {
        if isResting { return "REST · \(setLine)" }
        if let exerciseLine = exerciseLine { return "\(setLine) · \(exerciseLine)" }
        return setLine
    }

    /// Valid rest window, or nil when not resting (or data is inconsistent).
    var restInterval: ClosedRange<Date>? {
        guard isResting, let end = restEndTime, end > Date() else { return nil }
        let start = restStartTime ?? Date()
        guard end > start else { return nil }
        return start...end
    }

    /// Open-ended interval driving the counting-up elapsed timer.
    var elapsedInterval: ClosedRange<Date> {
        workoutStartTime...max(workoutStartTime.addingTimeInterval(24 * 3600), Date())
    }

    /// Fraction of the workout's exercises already passed (for the island's
    /// slim overall progress bar during the work phase).
    var workoutProgress: Double? {
        guard totalExercises > 0, exerciseIndex > 0 else { return nil }
        return Double(min(max(exerciseIndex - 1, 0), totalExercises)) / Double(totalExercises)
    }
}

@available(iOS 16.2, *)
private struct RestProgressBar: View {
    let interval: ClosedRange<Date>

    var body: some View {
        ProgressView(timerInterval: interval, countsDown: true) {
            EmptyView()
        } currentValueLabel: {
            EmptyView()
        }
        .progressViewStyle(.linear)
        .tint(brandBlue)
    }
}

/// Auto-updating countdown ring for the compact / minimal island during rest.
@available(iOS 16.2, *)
private struct RestRing: View {
    let interval: ClosedRange<Date>

    var body: some View {
        ProgressView(timerInterval: interval, countsDown: true) {
            EmptyView()
        } currentValueLabel: {
            EmptyView()
        }
        .progressViewStyle(.circular)
        .tint(brandBlue)
    }
}

@available(iOS 17.0, *)
private struct SkipRestButton: View {
    var body: some View {
        Button(intent: SkipRestIntent()) {
            Text("Skip Rest")
                .font(.subheadline.weight(.semibold))
                .frame(maxWidth: .infinity)
                .padding(.vertical, 4)
        }
        .buttonStyle(.borderedProminent)
        .tint(brandBlue)
    }
}

@available(iOS 16.2, *)
struct RestTimerLiveActivityWidget: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: RestTimerAttributes.self) { context in
            LockScreenView(state: context.state, isStale: context.isStale)
                // nil tint = the system's translucent notification material,
                // so the banner matches regular Apple notifications instead of
                // a solid black card.
                .activityBackgroundTint(nil)
                .activitySystemActionForegroundColor(.primary)
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    HStack(spacing: 10) {
                        ExerciseThumb(imageName: context.state.imageName, size: 44)
                            .opacity(context.isStale ? 0.45 : 1)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(
                                context.isStale
                                    ? "PAUSED"
                                    : (context.state.isResting
                                        ? "REST · \(context.state.setLine)"
                                        : context.state.setLine)
                            )
                            .font(.caption2.weight(.semibold))
                            .tracking(0.5)
                            .foregroundColor(
                                context.isStale
                                    ? .white.opacity(0.5)
                                    : (context.state.isResting ? brandBlue : .white.opacity(0.6))
                            )
                            Text(context.state.exerciseName)
                                .font(.subheadline.weight(.semibold))
                                .foregroundColor(context.isStale ? .white.opacity(0.6) : .white)
                                .lineLimit(2)
                                .minimumScaleFactor(0.75)
                        }
                    }
                    .padding(.leading, 2)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    if context.isStale {
                        // No running timers on a stale island — the app is gone
                        // and nothing is actually counting.
                        Image(systemName: "pause.circle.fill")
                            .font(.title2)
                            .foregroundColor(.white.opacity(0.5))
                            .padding(.trailing, 2)
                    } else {
                        VStack(alignment: .trailing, spacing: 2) {
                            Text(context.state.isResting ? "REMAINING" : "ELAPSED")
                                .font(.system(size: 9, weight: .semibold))
                                .tracking(0.5)
                                .foregroundColor(.white.opacity(0.5))
                            if let restInterval = context.state.restInterval {
                                Text(timerInterval: restInterval, countsDown: true)
                                    .font(.title2.weight(.bold).monospacedDigit())
                                    .foregroundColor(brandBlue)
                                    .frame(maxWidth: 64, alignment: .trailing)
                                    .multilineTextAlignment(.trailing)
                            } else {
                                Text(timerInterval: context.state.elapsedInterval, countsDown: false)
                                    .font(.title3.weight(.semibold).monospacedDigit())
                                    .foregroundColor(.white)
                                    .frame(maxWidth: 76, alignment: .trailing)
                                    .multilineTextAlignment(.trailing)
                                    .minimumScaleFactor(0.8)
                            }
                        }
                        .padding(.trailing, 2)
                    }
                }
                DynamicIslandExpandedRegion(.bottom) {
                    if context.isStale {
                        Text("Workout paused — open LiftAI to continue")
                            .font(.caption)
                            .foregroundColor(.white.opacity(0.55))
                            .frame(maxWidth: .infinity)
                            .padding(.top, 6)
                    } else if let restInterval = context.state.restInterval {
                        VStack(spacing: 8) {
                            RestProgressBar(interval: restInterval)
                            if #available(iOS 17.0, *) {
                                SkipRestButton()
                            }
                        }
                        .padding(.horizontal, 2)
                        .padding(.top, 6)
                    } else if let exerciseLine = context.state.exerciseLine {
                        HStack(spacing: 10) {
                            Text(exerciseLine)
                                .font(.caption2.weight(.semibold))
                                .tracking(0.5)
                                .foregroundColor(.white.opacity(0.6))
                            Spacer(minLength: 8)
                            if let progress = context.state.workoutProgress {
                                ProgressView(value: progress)
                                    .progressViewStyle(.linear)
                                    .tint(brandBlue)
                                    .frame(width: 96)
                            }
                        }
                        .padding(.horizontal, 2)
                        .padding(.top, 4)
                    }
                }
            } compactLeading: {
                if context.isStale {
                    Image(systemName: "pause.circle.fill")
                        .foregroundColor(.white.opacity(0.5))
                } else if let restInterval = context.state.restInterval {
                    // Countdown ring: reads as "resting" at a glance and drains
                    // in sync with the trailing digits.
                    RestRing(interval: restInterval)
                } else {
                    Image(systemName: "figure.strengthtraining.traditional")
                        .foregroundColor(brandBlue)
                }
            } compactTrailing: {
                if context.isStale {
                    Text("Paused")
                        .font(.caption2.weight(.semibold))
                        .foregroundColor(.white.opacity(0.5))
                } else if let restInterval = context.state.restInterval {
                    Text(timerInterval: restInterval, countsDown: true)
                        .monospacedDigit()
                        .foregroundColor(brandBlue)
                        .frame(maxWidth: 48)
                        .minimumScaleFactor(0.8)
                } else {
                    Text(timerInterval: context.state.elapsedInterval, countsDown: false)
                        .monospacedDigit()
                        .foregroundColor(.white)
                        .frame(maxWidth: 56)
                        .minimumScaleFactor(0.8)
                }
            } minimal: {
                if context.isStale {
                    Image(systemName: "pause.circle.fill")
                        .foregroundColor(.white.opacity(0.5))
                } else if let restInterval = context.state.restInterval {
                    RestRing(interval: restInterval)
                } else {
                    Image(systemName: "figure.strengthtraining.traditional")
                        .foregroundColor(brandBlue)
                }
            }
            .keylineTint(brandBlue)
        }
    }
}

@available(iOS 16.2, *)
struct LockScreenView: View {
    let state: RestTimerAttributes.ContentState
    var isStale: Bool = false

    var body: some View {
        VStack(spacing: 10) {
            HStack(alignment: .center, spacing: 12) {
                ExerciseThumb(imageName: state.imageName, size: 46)
                    .opacity(isStale ? 0.5 : 1)
                VStack(alignment: .leading, spacing: 2) {
                    Text(isStale ? "WORKOUT PAUSED" : state.contextLine)
                        .font(.caption2.weight(.semibold))
                        .tracking(0.6)
                        .foregroundStyle(isStale ? Color.secondary : (state.isResting ? brandBlue : Color.secondary))
                    Text(state.exerciseName)
                        .font(.headline)
                        .foregroundStyle(isStale ? Color.secondary : Color.primary)
                        .lineLimit(2)
                        .minimumScaleFactor(0.85)
                    if isStale {
                        Text("Open LiftAI to continue")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                Spacer(minLength: 10)
                if isStale {
                    Image(systemName: "pause.circle.fill")
                        .font(.system(size: 28))
                        .foregroundStyle(.secondary)
                } else if let restInterval = state.restInterval {
                    Text(timerInterval: restInterval, countsDown: true)
                        .font(.system(size: 30, weight: .bold, design: .rounded).monospacedDigit())
                        .foregroundStyle(brandBlue)
                        .frame(maxWidth: 86, alignment: .trailing)
                        .multilineTextAlignment(.trailing)
                } else {
                    VStack(alignment: .trailing, spacing: 0) {
                        Text(timerInterval: state.elapsedInterval, countsDown: false)
                            .font(.system(size: 24, weight: .semibold, design: .rounded).monospacedDigit())
                            .foregroundStyle(.primary)
                            .frame(maxWidth: 96, alignment: .trailing)
                            .multilineTextAlignment(.trailing)
                            .minimumScaleFactor(0.8)
                        Text("elapsed")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                }
            }
            if !isStale, let restInterval = state.restInterval {
                RestProgressBar(interval: restInterval)
                if #available(iOS 17.0, *) {
                    SkipRestButton()
                }
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 14)
    }
}
