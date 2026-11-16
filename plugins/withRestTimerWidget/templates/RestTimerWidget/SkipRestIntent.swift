import AppIntents
import Foundation

@available(iOS 17.0, *)
struct SkipRestIntent: LiveActivityIntent {
    static var title: LocalizedStringResource = "Skip Rest"
    static var description = IntentDescription("Skip the current rest timer in LiftAI.")

    init() {}

    func perform() async throws -> some IntentResult {
        let name = "com.example.liftai.RestTimerSkip" as CFString
        CFNotificationCenterPostNotification(
            CFNotificationCenterGetDarwinNotifyCenter(),
            CFNotificationName(name),
            nil,
            nil,
            true
        )
        if let defaults = UserDefaults(suiteName: "group.com.example.liftai") {
            defaults.set(Date().timeIntervalSince1970, forKey: "lastSkipRequestedAt")
        }
        return .result()
    }
}
