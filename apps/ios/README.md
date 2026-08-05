# Project Booth for iOS

The M9 native foundation targets iOS 17 and uses SwiftUI, Swift Concurrency,
Observation, URLSession, Keychain, and the generated `BoothAPI` OpenAPI module.
The app is feature-first under `BoothApp/`; server projections flow through one
`MatchStore`, and views do not own game rules.

Open `BoothApp.xcodeproj` or build from the repository root:

```sh
xcodebuild \
  -project apps/ios/BoothApp.xcodeproj \
  -scheme BoothApp \
  -destination 'generic/platform=iOS Simulator' \
  -skipPackagePluginValidation \
  CODE_SIGNING_ALLOWED=NO build
```

Run tests by selecting an installed simulator:

```sh
xcodebuild \
  -project apps/ios/BoothApp.xcodeproj \
  -scheme BoothApp \
  -destination 'platform=iOS Simulator,name=iPhone SE (3rd generation)' \
  -skipPackagePluginValidation \
  CODE_SIGNING_ALLOWED=NO test
```

Development defaults to `http://127.0.0.1:3000`. Set
`BOOTH_ENVIRONMENT` to `staging` or `production`, or use
`BOOTH_API_BASE_URL` as a local launch override. Production-facing URLs remain
placeholders until deployment is selected in M14.
