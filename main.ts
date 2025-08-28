import { App, Plugin, PluginSettingTab, Setting, WorkspaceLeaf, Notice } from "obsidian";

interface SearchPinnedRememberSettings {
  // Whatever the search view reports as its state; we keep it opaque
  lastSearchState: any | null;
  // Whether to remember and restore the last query string
  rememberQuery: boolean;
}

const DEFAULT_SETTINGS: SearchPinnedRememberSettings = {
  lastSearchState: null,
  rememberQuery: false,
};

export default class SearchPinnedRememberPlugin extends Plugin {
  settings: SearchPinnedRememberSettings = DEFAULT_SETTINGS;
  private initializedSearchLeaves: WeakSet<WorkspaceLeaf> = new WeakSet();
  private leafWatchIntervals: WeakMap<WorkspaceLeaf, number> = new WeakMap();
  private leafLastStateStr: WeakMap<WorkspaceLeaf, string> = new WeakMap();

  async onload() {
    await this.loadSettings();

    // Command: open a pinned Search tab in the main area, restoring last state
    this.addCommand({
      id: "open-search-pinned-remember",
      name: "Open Search in pinned main tab (remember last settings)",
      callback: async () => {
        await this.openPinnedSearchWithLastState();
      },
      // You can assign your own hotkey in Obsidian > Settings > Hotkeys
    });

    // Command: snapshot current Search state (if a Search view is active)
    this.addCommand({
      id: "save-current-search-state",
      name: "Save current Search state now",
      callback: async () => {
        const st = this.getAnySearchState();
        if (st) {
          this.settings.lastSearchState = this.sanitizeSearchStateForPersistence(st);
          await this.saveSettings();
          new Notice("Search state saved.");
        } else {
          new Notice("No Search view found to save.");
        }
      },
    });

    // Command: clear saved state
    this.addCommand({
      id: "clear-saved-search-state",
      name: "Clear saved Search state",
      callback: async () => {
        this.settings.lastSearchState = null;
        await this.saveSettings();
        new Notice("Saved Search state cleared.");
      },
    });

    // Keep the saved state up-to-date as you tweak Search options
    // We listen for layout & active-leaf changes and snapshot the first Search leaf we see.
    this.registerEvent(
      this.app.workspace.on("layout-change", this.snapshotSearchState)
    );
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", this.snapshotSearchState)
    );

    // Automatically apply last saved Search state to any newly opened Search view
    this.registerEvent(
      this.app.workspace.on("layout-change", this.tryInitializeNewSearchLeaves)
    );
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", this.tryInitializeNewSearchLeaves)
    );

    // Attempt once on load as well
    await this.tryInitializeNewSearchLeaves();

    this.addSettingTab(new SearchPinnedRememberSettingTab(this.app, this));
  }

  onunload() {
    // events auto-unregistered by registerEvent()
  }

  private snapshotSearchState = async () => {
    const st = this.getAnySearchState();
    if (st) {
      this.settings.lastSearchState = this.sanitizeSearchStateForPersistence(st);
      await this.saveSettings();
    }
  };

  private getAnySearchState(): any | null {
    const leaves = this.app.workspace.getLeavesOfType("search");
    if (!leaves.length) return null;

    // Prefer the active search leaf if present, else the first one
    const activeLeaf = this.app.workspace.activeLeaf;
    const leaf: WorkspaceLeaf | undefined =
      activeLeaf && activeLeaf.view && typeof activeLeaf.view.getViewType === "function" && activeLeaf.view.getViewType() === "search"
        ? activeLeaf
        : leaves[0];

    if (!leaf) return null;

    // Round-trip the exact state object reported by the view
    const vs = leaf.getViewState();
    return vs?.state ?? null;
  }

  // Optionally remove the actual search query from the state before persisting
  private sanitizeSearchStateForPersistence(state: any): any {
    if (!state || typeof state !== "object") return state;
    if (this.settings.rememberQuery) return state;
    const { query, ...rest } = state;
    return rest;
  }

  private async openPinnedSearchWithLastState() {
    // Create a new main-area tab (“tab” target) and activate Search in it
    const leaf = this.app.workspace.getLeaf("tab");

    // Build the view state; if we have a saved state, apply it
    const viewState = {
      type: "search",
      active: true,
      state: this.settings.rememberQuery
        ? (this.settings.lastSearchState ?? {})
        : { ...(this.settings.lastSearchState ?? {}), query: "" },
    };

    await leaf.setViewState(viewState);

    // Pin it so subsequent navigations don’t replace the tab
    leaf.setPinned(true);

    // Start watching for changes to auto-save search settings/sort
    this.ensureWatchingLeaf(leaf);

    // Reveal focus to the new Search tab
    this.app.workspace.revealLeaf(leaf);

    // Optional: focus the search input after render
    window.setTimeout(() => {
      try {
        const input = leaf.view?.containerEl?.querySelector<HTMLInputElement>("input[type='search'], .workspace-leaf-content input");
        input?.focus();
      } catch {}
    }, 50);
  }

  // Apply saved Search settings/sort to newly created Search tabs (opened via default UI)
  private tryInitializeNewSearchLeaves = async () => {
    const leaves = this.app.workspace.getLeavesOfType("search");
    for (const leaf of leaves) {
      if (this.initializedSearchLeaves.has(leaf)) continue;
      this.initializedSearchLeaves.add(leaf);
      // Apply saved settings if available
      try {
        if (this.settings.lastSearchState) {
          const current = leaf.getViewState();
          await leaf.setViewState({
            ...current,
            state: this.settings.rememberQuery
              ? { ...this.settings.lastSearchState }
              : { ...this.settings.lastSearchState, query: "" },
          });
        }
      } catch {}

      // Always start watching this Search leaf to auto-save subsequent changes
      this.ensureWatchingLeaf(leaf);
    }
  };

  // Begin polling a Search leaf for state changes and auto-save them
  private ensureWatchingLeaf(leaf: WorkspaceLeaf) {
    if (this.leafWatchIntervals.has(leaf)) return;
    const poll = async () => {
      try {
        const viewType = leaf.view?.getViewType?.();
        // Stop watching if it's no longer a Search view
        if (viewType !== "search") {
          const id = this.leafWatchIntervals.get(leaf);
          if (id != null) {
            window.clearInterval(id);
            this.leafWatchIntervals.delete(leaf);
          }
          this.leafLastStateStr.delete(leaf);
          return;
        }

        const vs = leaf.getViewState();
        const currentState = vs?.state ?? null;
        const sanitizedState = this.sanitizeSearchStateForPersistence(currentState);
        const currentStr = JSON.stringify(sanitizedState);
        const prevStr = this.leafLastStateStr.get(leaf);
        if (currentStr && currentStr !== prevStr) {
          this.leafLastStateStr.set(leaf, currentStr);
          this.settings.lastSearchState = sanitizedState;
          await this.saveSettings();
        }
      } catch {}
    };

    // Poll at a modest rate to capture toggle/sort changes reliably without heavy cost
    const id = window.setInterval(poll, 800);
    this.leafWatchIntervals.set(leaf, id);
    this.registerInterval(id);
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
}

class SearchPinnedRememberSettingTab extends PluginSettingTab {
  plugin: SearchPinnedRememberPlugin;

  constructor(app: App, plugin: SearchPinnedRememberPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h3", { text: "Search: Pinned & Remember" });

    new Setting(containerEl)
      .setName("Remember search query")
      .setDesc("If enabled, the last search query will be saved and restored.")
      .addToggle(toggle => {
        toggle
          .setValue(this.plugin.settings.rememberQuery)
          .onChange(async (value) => {
            this.plugin.settings.rememberQuery = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Reset saved Search state")
      .setDesc("Forget the last Search toggles and sort order.")
      .addButton(btn => {
        btn.setButtonText("Clear").onClick(async () => {
          this.plugin.settings.lastSearchState = null;
          await this.plugin.saveSettings();
          new Notice("Saved Search state cleared.");
        });
      });
  }
}