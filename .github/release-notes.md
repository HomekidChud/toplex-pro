Toplix Pro __VERSION__ is now available on macOS, Windows, Linux, Android and iOS.

## What's new
- Two modes on desktop: a Chat / Computer toggle in the composer. Chat is the normal assistant. Computer (computer use) lets the AI read, write and run commands on your computer — but only inside folders you approve, never near credentials (SSH keys, keychains, .env, tokens are always blocked), and every file write or command is shown in an approval dialog before it runs. Commands can't run elevated, destructive ones are blocked, they are killed after 60 seconds, and everything is written to a local audit log. Manage approved folders in Settings, Behavior, Computer use.
- macOS: the `toplex://` sign-in link now works from the packaged app (the custom URL scheme is registered in the DMG builds), and sign-in callbacks that arrive while the app is still starting are no longer lost.
- Windows/Linux: same `toplex://` fix, and the single-instance lock is taken before anything else, so a second launch reliably hands the sign-in link to the running app.
- All devices: streaming responses now parse multi-line server-sent events correctly (some providers were silently dropping chunks), the chat search no longer crashes on older saved chats, and the tool loop can run more rounds so longer agent tasks finish.
- iPhone and iPad: a new `.ipa` download. Apple requires apps to be signed, so install it with AltStore, SideStore or Sideloadly using your own Apple ID (steps in INSTALL.md). On-device models are not included on iOS yet.
- Device diagnostics: Settings, Diagnostics (also reachable from the sign-in screens). It checks the internet connection, the device clock, storage, saved settings and chats, key formatting, ChatGPT sign-in, on-device models, the GPU and new releases. It explains each problem in plain words and fixes things only after you review the exact changes and allow them. It also checks quietly at start-up and offers to review serious problems. Reports never include keys or tokens.
- GPU fixes on Android: the app now declares the phone's OpenCL libraries (needed on Android 12 and later), remembers whether the GPU worked for each model, and detects when a GPU start closed the app. In that case the GPU is switched off automatically and the diagnostics explain it and offer to try again.
- Android 1.5.x installs update to 1.7.0 without uninstalling.

## Downloads
| Device | File |
| --- | --- |
| Mac (Apple Silicon) | `Toplix-Pro-__VERSION__-arm64.dmg` |
| Mac (Intel) | `Toplix-Pro-__VERSION__-x64.dmg` |
| Windows 10/11 (64-bit) | `Toplix-Pro-__VERSION__-win-x64.exe` |
| Linux (any distro) | `Toplix-Pro-__VERSION__-linux-x86_64.AppImage` |
| Linux (Debian/Ubuntu) | `Toplix-Pro-__VERSION__-linux-amd64.deb` |
| Android 7.0+ | `Toplix-Pro-__VERSION__-android.apk` |
| iPhone / iPad (sideload) | `Toplix-Pro-__VERSION__-ios.ipa` |

## Install notes
- macOS: open the DMG, drag to Applications. If macOS says the app is damaged: `xattr -dr com.apple.quarantine '/Applications/Toplix Pro.app'`. See INSTALL.md.
- Windows: run the installer. SmartScreen may warn because the app is unsigned; choose More info, then Run anyway.
- Linux: `chmod +x Toplix-Pro-*.AppImage && ./Toplix-Pro-*.AppImage`, or `sudo apt install ./Toplix-Pro-*.deb`.
- Android: download the APK on your phone, open it and allow installs from your browser or file manager when asked. If you installed 1.4.0 or earlier, uninstall it once first (those builds used a temporary key). From 1.4.1 onward, updates install directly over the existing app.
