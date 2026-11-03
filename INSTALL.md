# Toplix Pro — Installation Guide (macOS)

## Option 1: Download the DMG (easiest)

1. Go to the **Releases** page of this repository.
2. Under the latest release, download the DMG for your Mac:
   - **Apple Silicon** (M1/M2/M3/M4): `Toplix-Pro-1.2.0-arm64.dmg`
   - **Intel** Macs: `Toplix-Pro-1.2.0-x64.dmg`
   - Not sure which Mac you have? Apple menu → About This Mac → look for "Chip".
3. Double-click the DMG to open it.
4. Drag the **Toplix Pro** icon onto the **Applications** folder shortcut.
5. Eject the DMG (right-click it in Finder → Eject) and delete the .dmg file if you want.

## First launch — Gatekeeper (important)

Toplix Pro is not distributed through the App Store and is not signed with an Apple Developer certificate, so macOS shows a warning the first time. This is expected for indie apps.

**macOS Sequoia / Sonoma and later:**

1. Try to open Toplix Pro from Applications.
2. If macOS blocks it with "cannot be opened because the developer cannot be verified":
   - **Right-click** (or Control-click) the app in Applications and choose **Open**.
   - In the dialog, click **Open** again.
   - That's it — macOS remembers your choice and won't ask again.

**If the right-click trick doesn't show the option:**

1. Open **System Settings → Privacy & Security**.
2. Scroll down — you'll see a message about "Toplix Pro was blocked".
3. Click **Open Anyway**, then confirm.

> Why this happens: unsigned apps trigger Gatekeeper on first run. The right-click → Open flow is Apple's official way to approve an app you trust. Toplix Pro makes no background connections — it only talks to the AI providers you configure.

## If macOS says "Toplix Pro is damaged and can't be opened"

This happens on macOS 13+ when an app has no code signature at all (macOS calls every fully-unsigned app "damaged"). Releases from **v1.2.0** onward are ad-hoc codesigned, so this should not appear anymore. If it still does, remove the quarantine flag:

1. Open **Terminal** (⌘Space, type Terminal, Enter).
2. Paste this line and press Enter:

```bash
xattr -dr com.apple.quarantine "/Applications/Toplix Pro.app"
```

3. If it asks for your password, type it (nothing shows as you type) and press Enter.
4. Open Toplix Pro normally.

This command only removes the "downloaded from the internet" flag Apple attached to the file — it changes nothing else on your Mac. (If the app shows this immediately after installing an older release, the fastest fix is downloading v1.2.0 or later.)

## Set up your models

1. Open Toplix Pro (⌘, opens Settings, or click the gear icon).
2. Go to **Models & API keys** and paste a key for any provider:
   - **OpenAI** — keys from [platform.openai.com](https://platform.openai.com) (covers ChatGPT and Codex-optimized models)
   - **Anthropic (Claude)** — keys from [console.anthropic.com](https://console.anthropic.com)
   - **OpenRouter** — one key for many models
   - **Custom** — any OpenAI-compatible server, e.g. Ollama at `http://localhost:11434/v1`
3. Click **Save**, then pick a model from the dropdown in the top bar.
4. Type a message and press Enter.

Keys are stored only on your Mac and sent directly to the provider — nothing passes through any other server. Without a key the app runs in demo mode with simulated responses.

### Connect your ChatGPT account (magic link)

1. Open Settings → **Connectors**.
2. Click **Sign in with ChatGPT** — your browser opens the ChatGPT sign-in page.
3. Finish signing in on chatgpt.com. After the redirect, Toplix Pro receives the token automatically and the status turns green.
4. No ChatGPT API key? Paste an OpenAI key on the **Models** tab instead — same models.

### Add MCP servers

1. Open Settings → **Connectors**.
2. Under **MCP servers**, enter a name and the server URL (streamable HTTP, e.g. `https://example.com/mcp`) and click **Add**.
3. The status column shows how many tools the server offers. The model now sees those tools automatically and can call them while answering — each tool call appears as a collapsible card in the chat.
4. Paste a bearer token in the optional field if the server requires one.

## Option 2: Build the DMG yourself

Requires a Mac with Node.js 20+ and Xcode command-line tools (`xcode-select --install`):

```bash
git clone https://github.com/HomekidChud/toplex-pro.git
cd toplex-pro
npm install
npx electron-builder --mac dmg
```

The DMG appears in the `dist/` folder — install it exactly as in Option 1. Building from source is the most secure option: you can read every line of code before you run it.

## Option 3: Run from source (no packaging)

```bash
cd toplex-pro
npm install
npm start
```

## Troubleshooting

| Problem | Fix |
| --- | --- |
| "App can't be opened because it's from an unidentified developer" | Right-click the app → Open → Open (see Gatekeeper section above). |
| "'Toplix Pro' is damaged and can't be opened. You should move it to the Bin." | Download v1.2.0+, or run the `xattr` command in the "damaged app" section above. |
| ChatGPT sign-in finished but nothing happened | The browser must be the default one on this Mac — the token is passed back via the `toplex://` link. Retry, or paste an OpenAI key on the Models tab. |
| MCP server shows "Error" | Check the URL is a streamable HTTP MCP endpoint (not SSE-only), the bearer token is valid, and the server is reachable. |
| Nothing happens when I send a message | Check Settings → the right API key is set and the model name is valid for that provider. |
| "HTTP 401" | API key is missing or invalid. |
| "HTTP 404" | Model name or base URL is wrong for that provider. |
| Chat history disappeared | History is per-browser-profile in the web preview; the Mac app stores it locally and keeps it between launches. |

## Uninstall

Drag Toplix Pro from Applications to the Trash. App data (settings, keys, chats) is stored in `~/Library/Application Support/toplex-pro/` — delete that folder to remove everything.
