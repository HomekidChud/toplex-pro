Toplix Pro __VERSION__ is now available on macOS, Windows, Linux and Android.

## What's new
- Android updates now install over the old version. The APK is signed with a permanent key and the version number always increases, so you no longer need to uninstall first.
- Sign-in network calls are more reliable: automatic retries, and a DNS-over-HTTPS fallback when the phone cannot resolve auth.openai.com. A clearer message is shown if the phone is genuinely offline.
- First-run permissions and required sign-in (ChatGPT plan, Claude via API key, or any provider key) from 1.4.0 carry over.

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
