Toplix Pro __VERSION__ is now available on macOS, Windows, Linux and Android.

## What's new
- First-run permissions: before anything else, Toplix Pro asks for internet access to your chosen AI provider and, on Android, an optional installed-or-not check for the ChatGPT and Claude apps. It never reads other apps' network traffic or data.
- Required sign-in: continue with ChatGPT (official Sign in with ChatGPT, uses your ChatGPT plan), connect Claude with an Anthropic API key, or use any provider API key.
- ChatGPT tokens are stored encrypted (Android Keystore / OS keychain) and refreshed automatically.
- Adaptive UI from 1.3.1 carries over.

## Downloads
| Device | File |
| --- | --- |
| Mac (Apple Silicon) | `Toplix-Pro-__VERSION__-arm64.dmg` |
| Mac (Intel) | `Toplix-Pro-__VERSION__-x64.dmg` |
| Windows 10/11 (64-bit) | `Toplix-Pro-__VERSION__-win-x64.exe` |
| Linux (any distro) | `Toplix-Pro-__VERSION__-linux-x86_64.AppImage` |
| Linux (Debian/Ubuntu) | `Toplix-Pro-__VERSION__-linux-amd64.deb` |
| Android 7.0+ | `Toplix-Pro-__VERSION__-android.apk` |

## Install notes
- macOS: open the DMG, drag to Applications. If macOS says the app is damaged: `xattr -dr com.apple.quarantine '/Applications/Toplix Pro.app'`. See INSTALL.md.
- Windows: run the installer. SmartScreen may warn because the app is unsigned; choose More info, then Run anyway.
- Linux: `chmod +x Toplix-Pro-*.AppImage && ./Toplix-Pro-*.AppImage`, or `sudo apt install ./Toplix-Pro-*.deb`.
- Android: download the APK on your phone, open it and allow installs from your browser or file manager when asked.
