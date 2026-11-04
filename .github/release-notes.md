Toplix Pro __VERSION__ is now available on macOS, Windows, Linux and Android.

## What's new
- Run AI models on your phone (Android, 64-bit ARM). Open the first-run screen or Settings, choose "On this phone", and pick a model: Qwen2.5 0.5B or 1.5B, Gemma 3 1B (needs a free Hugging Face token) or a tiny test model. You can also import your own `.task` or `.litertlm` file.
- Toplix Pro asks your permission before using the phone GPU, storing model files and downloading from huggingface.co. Android has no separate GPU permission, so the app asks itself. You can choose CPU only, and it falls back to CPU if the GPU cannot start.
- Chats with a local model stay on the phone and work offline once the model is downloaded. Local models do not use tools.
- The Custom provider now lists the models from Ollama or LM Studio automatically, and Android allows plain http addresses on your Wi-Fi (for example http://192.168.1.20:11434/v1).
- Updates install over 1.4.1 and later without uninstalling. The APK is about 20 MB larger because of the on-device engine.
- This is the first release of the on-device engine and has not been verified on every phone. Recent flagship phones (Pixel 8, Galaxy S23 or newer) work best.

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
