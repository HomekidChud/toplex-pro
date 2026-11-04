# Toplix Pro

A fast, focused AI coding assistant for macOS, Windows, Linux, Android and iOS — inspired by the best parts of Codex, Claude Code and modern chat UIs. One window, your models, zero clutter.

![Toplix Pro](renderer/icon.png)

## Features

- **Automatic updates** — the app asks once whether it should keep itself updated; if you say yes it checks for new versions in the background and updates itself (Windows and Linux install with one click, Mac opens the download page). Change it any time in Settings → Updates
- **Multi-provider models** — connect OpenAI (ChatGPT & Codex models), Anthropic (Claude), OpenRouter, or any OpenAI-compatible endpoint (Ollama, LM Studio, Groq…). The model picker shows a **FREE / PAID / LOCAL** badge on every model and a legend, so free options (on-device models, `:free` OpenRouter variants, GLM flash) are easy to spot
- **MCP tool servers** — connect Model Context Protocol servers (streamable HTTP) and the model can call their tools mid-conversation, with collapsible tool cards in the chat
- **Two modes on desktop** — switch between **Chat** (normal chat) and **Computer** (computer use): the AI gets its own Chromium browser with its own visible mouse cursor, can open apps and tabs, read/write files and run commands — under a permission system you control (manual approval or "approve for me", and optional full computer access)
- **Live token meter** — every assistant message shows a tokens/second readout that updates continuously while it streams, plus the message's total tokens and the chat's running total, right next to the like/dislike buttons
- **ChatGPT magic-link sign-in** — sign in from chatgpt.com in your browser; Toplix Pro receives the token automatically via its custom URL scheme
- **Streaming responses** with markdown rendering, syntax-highlighted code blocks and one-click copy
- **Chat history** with a searchable sidebar, stored locally
- **Dark & light themes**, keyboard shortcuts (⌘N new chat, ⌘, settings, Esc stop)
- **Private by design** — API keys and chats live only on your Mac, requests go straight from the app to the provider

## Two modes: Chat and Computer use (desktop)

The toggle next to the model picker switches between:

1. **Chat** — normal chat. The AI answers in the chat window and cannot touch your computer.
2. **Computer** — computer use. The AI gets a full toolset (`computer_list_files`, `computer_read_file`, `computer_write_file`, `computer_run_command`, `computer_list_apps`, `computer_open_app`, `computer_open_url`, and the AI Browser tools below) and can do real work on your machine under strict rules enforced by the app itself, not by the model's good behaviour:

### Permissions: manual or "approve for me"

- **Manual (default)** — every file write, command and app launch is shown in a native approval dialog with the exact target and command before it runs. Any dialog also offers **"Approve for me — auto from now on"**, which switches to auto mode on the spot.
- **Approve for me (auto)** — the AI can work without stopping for approvals. Everything is still written to the local audit log, and you can switch back to manual any time in Settings.
- **Full computer access** — optional, and off by default. When you switch it on (Settings, or from the mode banner), the AI can read and change files anywhere on the computer and open any app — not just inside approved folders. Turning it on asks for confirmation first.
- **Credentials are always off-limits**, whatever you choose: SSH/GPG/AWS keys, keychains, `.env` files, tokens and Toplix Pro's own data are blocked even with full access.
- Commands **never run elevated** (`sudo` is blocked), destructive and self-hiding commands are blocked outright, and each command is killed after 60 seconds with capped output.
- Everything the AI does is recorded in a local audit log.

### The AI Browser and the AI's own mouse

The AI gets its own embedded Chromium browser — a separate window the user can watch:

- `browser_open` / `browser_new_tab` / `browser_tabs` / `browser_close_tab` — open sites, manage tabs (links that open new windows become new tabs automatically)
- `browser_read_page` — title, URL, visible text and links of the active tab
- `browser_screenshot` — saves a PNG the user can open; coordinates match `browser_click` x/y
- `browser_click` / `browser_click_selector` / `browser_type` / `browser_key` / `browser_scroll` / `browser_back` / `browser_forward` — act on pages
- `ai_mouse_move` / `ai_mouse_click` — the AI has **its own visible mouse cursor**: a purple pointer with an "AI" badge that moves and clicks inside the AI Browser. The user's real mouse is never moved or captured — clicks are injected into the browser's page, and the cursor the user sees is an overlay drawing.

The AI Browser is the AI's sandbox: pages it opens, tabs it manages and clicks it makes happen there, never in the user's own browser. Opening a link in the user's default browser (`computer_open_url` with `where:"default"`) is a separate action that needs approval in manual mode.

If the AI asks for something outside these rules, the app itself refuses — the safety lives in the Electron main process, so the renderer and the model cannot relax it.

## Install

Downloads for every device are on the [Releases](../../releases) page: macOS (`.dmg`), Windows (`.exe`), Linux (`.AppImage` / `.deb`) Android (`.apk`) and iOS (`.ipa`, sideloaded, see INSTALL.md).

### macOS

The easiest way: download the ready-made DMG from the [Releases](../../releases) page and follow [INSTALL.md](INSTALL.md).

Or build it yourself (requires a Mac with Xcode command-line tools):

```bash
git clone https://github.com/HomekidChud/toplex-pro.git
cd toplex-pro
npm install
npx electron-builder --mac dmg
```

The DMG appears in `dist/`.

## Connect your models

1. Open **Settings → Models & API keys** (⌘,)
2. Paste the API key for a provider:
   - **OpenAI** (ChatGPT / Codex models) — key from [platform.openai.com](https://platform.openai.com)
   - **Anthropic (Claude)** — key from [console.anthropic.com](https://console.anthropic.com)
   - **OpenRouter** — one key for hundreds of models
   - **Custom** — any OpenAI-compatible base URL (Ollama at `http://localhost:11434/v1`, LM Studio, etc.)
3. Pick a model from the picker in the top bar and start chatting.

Without a key the app runs in **demo mode** with simulated responses, so you can explore the UI first.

## Run in development

```bash
npm install
npm start
```

## The model brain — ToplixPro.md

`renderer/ToplixPro.md` is the master instruction set for every Toplix Pro
model: identity, operating principles, the computer-use playbooks (files,
commands, apps, the AI Browser), tool discipline and safety rules. It is read
by the preload script and prepended to every request's system prompt — before
the user's own prompt and the computer-use rules. Edit that file to change how
every model in the app thinks and works.

## Building on other platforms

The app is a standard Electron project — `npx electron-builder` on Windows or Linux produces those platforms' installers. DMGs can only be built on macOS (or via the included GitHub Actions workflow, which builds both Apple Silicon and Intel DMGs automatically).

## License

Copyright © 2026 HomekidChud. All rights reserved.

This source code is proprietary. You may not copy, modify, redistribute, or create derivative works from it without the owner's written permission. See [LICENSE](LICENSE) for the full terms.
