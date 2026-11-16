import 'dotenv/config';

export default {
  expo: {
    name: 'LiftAI',
    slug: 'LiftAI',
    version: '2.1.0',
    orientation: 'portrait',
    icon: './assets/images/icon.png',
    scheme: 'liftaiapp',
    userInterfaceStyle: 'automatic',
    newArchEnabled: true,
    ios: {
      supportsTablet: true,
      bundleIdentifier: 'com.example.liftai',
      buildNumber: '22',
      infoPlist: {
        ITSAppUsesNonExemptEncryption: false,
        CFBundleDisplayName: 'LiftAI',
        NSUserNotificationsUsageDescription:
          'LiftAI sends workout reminders, progress updates, and motivational messages to help you stay on track with your fitness goals.',
        // Required by Apple for any app that uses AdMob / IDFA
        NSUserTrackingUsageDescription:
          'We use this to show you relevant ads that support the free version of LiftAI.',
        // --- VOICE COACH STASHED (not shipping this version) ---
        // The mic permission + background-audio mode below are only used by the
        // voice coach. They are disabled so the build declares no mic/background
        // audio capability (Apple Guideline 2.5.4). Restore both lines when the
        // voice feature ships again.
        // NSMicrophoneUsageDescription:
        //   'LiftAI uses your microphone for the voice coach so it can hear how you sound during a set and respond in real time. The mic is off until you tap the mic button.',
        // UIBackgroundModes: ['audio'],
        // --- end stash ---
        // Nutrition camera: snap a photo of a meal for AI calorie/macro
        // logging, and scan barcodes on packaged foods.
        NSCameraUsageDescription:
          'LiftAI uses your camera to snap photos of your meals and scan barcodes so the AI can log calories and macros for you.',
        // Live Activities (rest timer Dynamic Island + lock-screen widget).
        NSSupportsLiveActivities: true,
        NSSupportsLiveActivitiesFrequentUpdates: true,
      },
      entitlements: {
        // App Group enables the RestTimerWidget extension to signal the app
        // (e.g. "Skip Rest" tap) via shared UserDefaults + Darwin notifications.
        'com.apple.security.application-groups': ['group.com.example.liftai'],
        // APNs environment. We set EXPO_NO_CAPABILITY_SYNC=1 in eas.json, which
        // stops EAS from auto-flipping this to "production" at build time, so we
        // must pin it ourselves based on the build profile. Without "production"
        // here, App Store / TestFlight builds register sandbox push tokens and
        // production notifications silently never arrive.
        'aps-environment':
          process.env.EAS_BUILD_PROFILE === 'production'
            ? 'production'
            : 'development',
      },
    },
    android: {
      package: 'com.example.liftai',
      versionCode: 7,
      adaptiveIcon: {
        backgroundColor: '#000000',
        foregroundImage: './assets/images/android-icon-foreground.png',
        backgroundImage: './assets/images/android-icon-background.png',
        monochromeImage: './assets/images/android-icon-monochrome.png',
      },
      edgeToEdgeEnabled: true,
      predictiveBackGestureEnabled: false,
      permissions: [
        'android.permission.INTERNET',
        'android.permission.POST_NOTIFICATIONS',
        'android.permission.VIBRATE',
        'com.google.android.gms.permission.AD_ID',
        // --- VOICE COACH STASHED (not shipping this version) ---
        // Mic + audio routing for the WebRTC voice connection. Restore when the
        // voice feature ships again.
        // 'android.permission.RECORD_AUDIO',
        // 'android.permission.MODIFY_AUDIO_SETTINGS',
        // --- end stash ---
        // Barcode scanner for the nutrition page.
        'android.permission.CAMERA',
      ],
    },
    web: {
      output: 'static',
      favicon: './assets/images/favicon.png',
    },
    plugins: [
      'expo-router',
      // App Tracking Transparency. Provides the native ATT prompt that MUST be
      // shown before AdMob reads the IDFA on iOS (Apple Guideline 5.1.2). The
      // prompt copy comes from NSUserTrackingUsageDescription above; the call
      // site is utils/initAds.ts.
      [
        'expo-tracking-transparency',
        {
          userTrackingPermission:
            'We use this to show you relevant ads that support the free version of LiftAI.',
        },
      ],
      [
        'expo-splash-screen',
        {
          image: './img/white-v-nobg.png',
          imageWidth: 200,
          resizeMode: 'contain',
          backgroundColor: '#000000',
          dark: {
            backgroundColor: '#000000',
          },
        },
      ],
      'expo-font',
      'expo-apple-authentication', // Required for native Apple Sign-In
      // react-native-google-mobile-ads — requires a native rebuild after adding.
      // Set EXPO_PUBLIC_ADMOB_IOS_APP_ID and EXPO_PUBLIC_ADMOB_ANDROID_APP_ID in .env
      // to your real AdMob App IDs (format: ca-app-pub-XXXXXXXXXXXXXXXX~XXXXXXXXXX).
      // The fallbacks below are Google's official test app IDs — safe for development.
      [
        'react-native-google-mobile-ads',
        {
          androidAppId:
            process.env.EXPO_PUBLIC_ADMOB_ANDROID_APP_ID ??
            'ca-app-pub-3940256099942544~3347511713',
          iosAppId:
            process.env.EXPO_PUBLIC_ADMOB_IOS_APP_ID ??
            'ca-app-pub-3940256099942544~1458002511',
        },
      ],
      // --- VOICE COACH STASHED (not shipping this version) ---
      // The react-native-webrtc config plugin links the WebRTC framework and
      // declares the mic permission. It is removed so the voice feature is
      // fully absent from the native binary (Apple Guideline 2.5.4). To restore:
      // re-add this plugin entry AND the react-native-webrtc + @config-plugins
      // deps in package.json, then `npx expo prebuild --clean`.
      // [
      //   '@config-plugins/react-native-webrtc',
      //   {
      //     cameraPermission: false,
      //     microphonePermission:
      //       'LiftAI needs your mic so the voice coach can hear you during a set.',
      //   },
      // ],
      // --- end stash ---
      // Nutrition camera (photo meal logging + barcode scanner). expo-camera
      // handles the native permission strings on iOS + Android via this entry.
      [
        'expo-camera',
        {
          cameraPermission:
            'LiftAI uses your camera to snap photos of your meals and scan barcodes so the AI can log calories and macros for you.',
          // Barcode scanning never records audio. Explicitly disable the mic
          // permission on BOTH platforms so the build declares no microphone
          // capability (Apple Guideline 2.5.4 / 5.1.1). Without this, expo-camera
          // injects a generic NSMicrophoneUsageDescription + RECORD_AUDIO.
          microphonePermission: false,
          recordAudioAndroid: false,
        },
      ],
      // Photo meal logging: gallery picker on the capture screen ("the meal I
      // ate at lunch"). Read-only photo access; no camera/mic strings here —
      // expo-camera above owns those.
      [
        'expo-image-picker',
        {
          photosPermission:
            'LiftAI lets you pick a photo of a meal from your library so the AI can log its calories and macros.',
          cameraPermission: false,
          microphonePermission: false,
        },
      ],
      // Live Activity / Dynamic Island for the rest timer. Adds the
      // RestTimerWidget app-extension target + LiftLiveActivityModule
      // native bridge during prebuild so manual Xcode work is no longer
      // needed (and isn't wiped by `expo prebuild --clean`).
      './plugins/withRestTimerWidget',
    ],
    experiments: {
      typedRoutes: true,
      reactCompiler: true,
    },
    extra: {
      router: {},
      eas: {
        projectId: process.env.EAS_PROJECT_ID,
      },
      revenueCatApiKey: process.env.EXPO_PUBLIC_REVENUECAT_API_KEY,
      revenueCatApiKeyIos:
        process.env.EXPO_PUBLIC_REVENUECAT_API_KEY_IOS ??
        process.env.EXPO_PUBLIC_REVENUECAT_API_KEY,
      revenueCatApiKeyAndroid:
        process.env.EXPO_PUBLIC_REVENUECAT_API_KEY_ANDROID ??
        process.env.EXPO_PUBLIC_REVENUECAT_API_KEY,
      supabaseUrl: process.env.EXPO_PUBLIC_SUPABASE_URL,
      supabaseAnonKey: process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY,
      exerciseDbApiKey: process.env.EXPO_PUBLIC_EXERCISEDB_API_KEY,
      posthogProjectToken: process.env.POSTHOG_PROJECT_TOKEN,
      posthogHost: process.env.POSTHOG_HOST,
    },
  },
};

