Toplix Pro __VERSION__ is now available on macOS, Windows, Linux and Android.

## What's new
- Fixes the ChatGPT sign-in `invalid_grant` error. If ChatGPT rejects the first sign-in code, Toplix Pro now follows OpenAI's documented recovery: it discards the code and automatically starts one more authorization with the client ID issued to your app, then tells you to confirm again in the browser.
- The Android network layer never resubmits a one-time sign-in code after a timeout.
- If it still fails, the message now explains what to do instead of showing a bare error code.
- Android updates install over the old version since 1.4.1 (permanent signing key). Sign-in network retries and DNS fallback from 1.4.1 carry over.

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
- Android: download the APK on your phone, open it and allow installs from your browser or file manager when asked. If you installed 1.4.0 or earlier, uninstall it once first (those builds used a temporary key). From 1.4.1 onward, updates install directly over the existing app.
