# AIRewards for Visual Studio Code & Compatible Editors

Official Visual Studio Code extension for [AIRewards](https://www.airewards.tech), the privacy-first advertising network for developers. Compatible with **VS Code**, **Cursor**, and **Windsurf**.

## Overview

AIRewards displays lightweight, unobtrusive, text-only sponsored messages in your IDE status bar while you code. You earn a 50% revenue share for valid impressions with zero latency and zero interference with your editor.

- **Non-intrusive:** Sits quietly in the status bar.
- **Privacy-First:** Never inspects your code, files, prompts, or keystrokes.
- **Secure:** Stores your personal API key directly inside the OS Keychain via VS Code's `SecretStorage` API.

## Installation

### Method 1: Automatic 1-Step Installer (Recommended)
Run in your terminal:
```bash
npx -y @airewards/cli-wrapper install-extension
```

### Method 2: From Source
1. Clone this repository:
   ```bash
   git clone https://github.com/airewards/vscode-extension.git
   cd vscode-extension
   ```
2. Install dependencies & build:
   ```bash
   npm install
   npm run package:vsix
   ```
3. Install in VS Code:
   ```bash
   code --install-extension *.vsix
   ```

## Setup & Usage

1. Sign in to your [AIRewards Dashboard](https://www.airewards.tech) and copy your Developer API Key (`air_dev_...`).
2. In VS Code, open the Command Palette (`Ctrl+Shift+P` or `Cmd+Shift+P`).
3. Run `AIRewards: Set / Update API Key` and paste your key.
4. Your earn loop is active! You can run `AIRewards: Diagnose & Check Status` anytime to verify connectivity.

## Commands

- `AIRewards: Set / Update API Key` — Configure your personal API key.
- `AIRewards: Diagnose & Check Status` — Check backend connection and device registration.
- `AIRewards: Fetch Ad Now` — Request the latest sponsored line immediately.
- `AIRewards: Open Sponsored Ad` — Open the sponsor's destination link.

## Privacy & Security

AIRewards does **not**:
- Read your open files, git repositories, or workspace paths.
- Capture telemetry or telemetry keys.
- Send prompt contents to our servers.

The extension communicates strictly with `https://www.airewards.tech/v1/ads/current` and `https://www.airewards.tech/v2/impressions/challenges` using HTTPS and your authenticated API key.

## License

MIT © [AIRewards](https://www.airewards.tech)
