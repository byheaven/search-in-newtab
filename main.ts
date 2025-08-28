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
  private processedLeaves: WeakSet<WorkspaceLeaf> = new WeakSet();
  private leafCreationTime: WeakMap<WorkspaceLeaf, number> = new WeakMap();
  private leafWatchIntervals: WeakMap<WorkspaceLeaf, number> = new WeakMap();
  private leafBaselineState: WeakMap<WorkspaceLeaf, string> = new WeakMap();
  private allIntervalIds: number[] = [];

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

    // No automatic saving - user must use manual save command

    // Event-driven detection of new search views (no periodic checking)
    this.registerEvent(
      this.app.workspace.on("layout-change", this.handleSearchViewChanges)
    );
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", this.handleSearchViewChanges)
    );

    // Initial check on plugin load
    await this.handleSearchViewChanges();

    this.addSettingTab(new SearchPinnedRememberSettingTab(this.app, this));
  }

  onunload() {
    // Clear all intervals
    this.allIntervalIds.forEach(id => window.clearInterval(id));
    this.allIntervalIds = [];
    this.processedLeaves = new WeakSet();
    this.leafCreationTime = new WeakMap();
    this.leafWatchIntervals = new WeakMap();
    this.leafBaselineState = new WeakMap();
    // events auto-unregistered by registerEvent()
  }

  // Removed automatic snapshotSearchState - now only manual saving

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
    // Create a new main-area tab ("tab" target) and activate Search in it
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

    // Pin it so subsequent navigations don't replace the tab
    leaf.setPinned(true);

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

  // Handle search view changes (creation, activation, etc.)
  private handleSearchViewChanges = async () => {
    const leaves = this.app.workspace.getLeavesOfType("search");
    
    for (const leaf of leaves) {
      // Only process leaves we haven't seen before
      if (!this.processedLeaves.has(leaf)) {
        await this.processNewSearchLeaf(leaf);
      }
    }
  };

  // Process a newly detected search leaf
  private async processNewSearchLeaf(leaf: WorkspaceLeaf) {
    // Mark as processed immediately to avoid reprocessing
    this.processedLeaves.add(leaf);
    
    // Record creation time for immunity period
    this.leafCreationTime.set(leaf, Date.now());
    
    // Apply saved settings if available
    if (this.settings.lastSearchState) {
      await this.applySettingsToNewLeaf(leaf);
    }
    
    // Start monitoring for user changes (with immunity period)
    this.startIntelligentMonitoring(leaf);
  };

  // Apply saved settings to a newly created search leaf
  private async applySettingsToNewLeaf(leaf: WorkspaceLeaf) {
    try {
      const current = leaf.getViewState();
      
      // Build the desired state (preserve current query if not remembering queries)
      const desiredState = this.settings.rememberQuery
        ? { ...this.settings.lastSearchState }
        : { ...this.settings.lastSearchState, query: current?.state?.query || "" };
      
      const newState = {
        ...current,
        state: desiredState,
      };
      
      await leaf.setViewState(newState);
      
      // Record the baseline state after applying settings
      this.leafBaselineState.set(leaf, JSON.stringify(this.sanitizeSearchStateForPersistence(desiredState)));
      
      // Double-apply to ensure it sticks
      setTimeout(async () => {
        try {
          await leaf.setViewState(newState);
        } catch {}
      }, 100);
    } catch {}
  }

  // Removed normalizeState - no longer needed with simplified approach

  // Start intelligent monitoring for user changes
  private startIntelligentMonitoring(leaf: WorkspaceLeaf) {
    if (this.leafWatchIntervals.has(leaf)) return;
    
    const monitor = async () => {
      try {
        const viewType = leaf.view?.getViewType?.();
        if (viewType !== "search") {
          // Cleanup if no longer a search view
          this.cleanupLeafTracking(leaf);
          return;
        }

        const creationTime = this.leafCreationTime.get(leaf) || 0;
        const timeSinceCreation = Date.now() - creationTime;
        
        // Immunity period: don't save changes in first 2 seconds after creation
        if (timeSinceCreation < 2000) {
          return;
        }

        const vs = leaf.getViewState();
        const currentState = vs?.state ?? null;
        
        if (currentState) {
          const currentStr = JSON.stringify(this.sanitizeSearchStateForPersistence(currentState));
          const baselineStr = this.leafBaselineState.get(leaf);
          
          // Only save if state has changed from baseline (indicating user interaction)
          if (currentStr !== baselineStr && baselineStr) {
            // This is a user-initiated change, save it
            this.settings.lastSearchState = this.sanitizeSearchStateForPersistence(currentState);
            await this.saveSettings();
            
            // Update baseline to new state
            this.leafBaselineState.set(leaf, currentStr);
          }
        }
      } catch {}
    };

    // Monitor every 800ms (less frequent than before)
    const id = window.setInterval(monitor, 800);
    this.leafWatchIntervals.set(leaf, id);
    this.registerInterval(id);
    this.allIntervalIds.push(id);
  }

  // Clean up tracking data for a leaf
  private cleanupLeafTracking(leaf: WorkspaceLeaf) {
    const id = this.leafWatchIntervals.get(leaf);
    if (id != null) {
      window.clearInterval(id);
      this.leafWatchIntervals.delete(leaf);
      const index = this.allIntervalIds.indexOf(id);
      if (index > -1) {
        this.allIntervalIds.splice(index, 1);
      }
    }
    this.leafCreationTime.delete(leaf);
    this.leafBaselineState.delete(leaf);
    // Note: don't remove from processedLeaves as it's a WeakSet and will be GC'd automatically
  }

  // Removed isDefaultState - no longer needed with new tracking approach

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