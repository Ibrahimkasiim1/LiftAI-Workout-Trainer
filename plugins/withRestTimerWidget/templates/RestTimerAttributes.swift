import ActivityKit
import Foundation

@available(iOS 16.2, *)
public struct RestTimerAttributes: ActivityAttributes {
    public typealias RestTimerStatus = ContentState

    public struct ContentState: Codable, Hashable {
        public var exerciseName: String
        public var workoutName: String
        public var setNumber: Int
        public var totalSets: Int
        /// 1-based position of the current exercise in the workout. 0 = unknown,
        /// in which case the widget hides the "Exercise X of Y" line.
        public var exerciseIndex: Int
        public var totalExercises: Int
        /// Phase flag: the activity now spans the whole workout. `true` while the
        /// rest countdown runs, `false` while the user is lifting.
        public var isResting: Bool
        /// Rest window bounds. Only meaningful while `isResting`; the start date
        /// anchors the countdown progress bar.
        public var restStartTime: Date?
        public var restEndTime: Date?
        /// Anchors the elapsed-workout timer shown during the work phase.
        public var workoutStartTime: Date
        /// Filename (not full path) of the exercise GIF's first frame, written by
        /// the app to the shared App Group container. `nil` until the frame has
        /// been downloaded/decoded. The widget resolves it against the group
        /// container at render time so the image survives process boundaries.
        public var imageName: String?

        public init(
            exerciseName: String,
            workoutName: String,
            setNumber: Int,
            totalSets: Int,
            exerciseIndex: Int = 0,
            totalExercises: Int = 0,
            isResting: Bool = false,
            restStartTime: Date? = nil,
            restEndTime: Date? = nil,
            workoutStartTime: Date = Date(),
            imageName: String? = nil
        ) {
            self.exerciseName = exerciseName
            self.workoutName = workoutName
            self.setNumber = setNumber
            self.totalSets = totalSets
            self.exerciseIndex = exerciseIndex
            self.totalExercises = totalExercises
            self.isResting = isResting
            self.restStartTime = restStartTime
            self.restEndTime = restEndTime
            self.workoutStartTime = workoutStartTime
            self.imageName = imageName
        }
    }

    public init() {}
}
