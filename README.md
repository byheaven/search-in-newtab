## Search in new tab (Obsidian plugin)

Open the core Search view in a pinned main tab and remember your last search settings and sort automatically.

### Features
- **Pinned Search tab**: Opens Search in a new main-area tab and pins it, so navigating notes does not replace the tab.
- **Remembers your settings**: Automatically saves and restores Search view state (query, toggles, sort, etc.).
- **Auto-applies to new Search views**: When you open a new Search view, the saved state is applied.
- **Commands and hotkeys**: Comes with convenient commands; assign a hotkey in Settings → Hotkeys.

### Usage
1. Enable the plugin in Obsidian → Settings → Community plugins.
2. Open the command palette and run: "Open Search in pinned main tab (remember last settings)".
3. The Search view opens in a pinned main tab; start searching.
4. As you change Search options (toggles/sort), the plugin keeps your state up to date.
5. Next time you open Search with this command, your last state is restored.

Tip: Assign a hotkey for faster access in Obsidian → Settings → Hotkeys.

### Commands
- **Open Search in pinned main tab (remember last settings)**: Opens a pinned Search tab and applies your last saved state.
- **Save current Search state now**: Manually snapshots the active Search view state.
- **Clear saved Search state**: Forgets the saved state.

### Settings
- In Obsidian → Settings → Community Plugins → Search in new tab:
  - **Reset saved Search state**: Click "Clear" to remove the last remembered Search view state.

### Installation
- **Manual install (from built files)**
  - In your vault, create the folder: `.obsidian/plugins/search-in-newtab/`.
  - Copy `manifest.json`, `main.js`, and optionally `styles.css` into that folder.
  - Reload Obsidian and enable the plugin in Settings → Community plugins.

### Build from source (development)
- **Prerequisites**: Node.js (LTS) and npm.
- **Setup**:
  - Run `npm install` in this directory.
  - For development (watch + rebuild): `npm run dev`.
  - For a production build: `npm run build`.
  - Optional: bump version and update `manifest.json`/`versions.json`: `npm run version`.
- **Test in a vault**:
  - Copy (or symlink) the build outputs `manifest.json`, `main.js`, and `styles.css` into your vault at `.obsidian/plugins/search-in-newtab/`.
  - Reload plugins in Obsidian.


### Privacy & data
- The plugin stores your last Search view state locally in your vault at `.obsidian/plugins/search-in-newtab/data.json`.
- No data leaves your device.

### Troubleshooting
- **Search state does not restore**:
  - Ensure the plugin is enabled.
  - Use the command "Save current Search state now", then try reopening the pinned Search.
  - In Settings, click "Reset saved Search state" and try again.
- **Pinned tab is replaced by navigation**: Confirm the new Search tab is pinned (look for the pin icon).
- **Mobile quirks**: If behavior differs across platforms, clear the saved state and re-open the Search tab.

