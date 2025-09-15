import { App, Plugin, PluginSettingTab, Setting, WorkspaceLeaf, Notice } from "obsidian";

interface SearchPinnedRememberSettings {
  // Whatever the search view reports as its state; we keep it opaque
  lastSearchState: any | null;
  // Whether to remember and restore the last query string
  rememberQuery: boolean;
  // Whether to open search bookmarks in main area tabs instead of sidebar
  openBookmarksInMainArea: boolean;
  // Whether to clear sidebar search views on startup
  clearSidebarSearchOnStartup: boolean;
  // Whether to enable debug mode (show detailed console logs)
  debugMode: boolean;
  // Whether to automatically pin search tabs when opening them in main area
  autoPinSearchTab: boolean;
}

const DEFAULT_SETTINGS: SearchPinnedRememberSettings = {
  lastSearchState: null,
  rememberQuery: false,
  openBookmarksInMainArea: true, // Default to true for better UX
  clearSidebarSearchOnStartup: false,
  debugMode: false, // Default to false for clean user experience
  autoPinSearchTab: true, // Default to true for backward compatibility
};

export default class SearchPinnedRememberPlugin extends Plugin {
  settings: SearchPinnedRememberSettings = DEFAULT_SETTINGS;
  private processedLeaves: WeakSet<WorkspaceLeaf> = new WeakSet();
  private leafCreationTime: WeakMap<WorkspaceLeaf, number> = new WeakMap();
  private leafWatchIntervals: WeakMap<WorkspaceLeaf, number> = new WeakMap();
  private leafBaselineState: WeakMap<WorkspaceLeaf, string> = new WeakMap();
  private lastBookmarkClick: { query: string; timestamp: number } | null = null;
  private allIntervalIds: number[] = [];
  private detectionIntervalId: number | null = null;
  private lastRedirectionTime: number = 0;
  private originalExecuteCommand: any = null;
  private isInitialLoad: boolean = true;
  private initializationCompleteTime: number = 0;
  private lastRedirectionTriggerTime: number = 0;
  // Cache for leaf location detection to avoid repeated calculations
  private leafLocationCache: WeakMap<WorkspaceLeaf, boolean> = new WeakMap();
  // Removed complex API interception - using simple event-driven detection instead

  // Unified logging system - only logs when debug mode is enabled
  private debugLog(message: string, ...args: any[]) {
    if (this.settings.debugMode) {
      console.log(message, ...args);
    }
  }

  private debugWarn(message: string, ...args: any[]) {
    if (this.settings.debugMode) {
      console.warn(message, ...args);
    }
  }

  // Note: console.error calls remain unchanged - errors should always be visible

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

    // Optimized event-driven detection with separate responsibilities
    this.registerEvent(
      this.app.workspace.on("layout-change", this.handleLayoutChanges)
    );
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", this.handleActiveLeafChanges)
    );

    // Initial check on plugin load
    await this.handleLayoutChanges();

    // 🎯 Set up selective View State monitoring (only when redirection is enabled)
    if (this.settings.openBookmarksInMainArea) {
      this.setupViewStateMonitoring();
    }

    // Set up command hooking for keyboard shortcuts if enabled
    if (this.settings.openBookmarksInMainArea) {
      this.setupCommandInterception();
    }

    // 🎯 Set up startup cleanup to run after workspace is ready
    if (this.settings.clearSidebarSearchOnStartup) {
      this.setupStartupCleanup();
    }

    // 🎯 Mark initial load as complete AFTER all setup is done - real user interactions can now trigger redirection
    this.isInitialLoad = false;
    this.initializationCompleteTime = Date.now();
    this.debugLog('🚀 Plugin initial load complete - bookmark redirection now active');

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
    
    // Clear detection interval
    if (this.detectionIntervalId) {
      window.clearInterval(this.detectionIntervalId);
      this.detectionIntervalId = null;
    }
    
    // Restore original executeCommand method
    if (this.originalExecuteCommand && (this.app as any).commands) {
      (this.app as any).commands.executeCommand = this.originalExecuteCommand;
      this.originalExecuteCommand = null;
    }
    
    // Clean API interception removed - using simple event-driven detection instead
    
    // events auto-unregistered by registerEvent()
  }

  // Check if we're still in the initialization grace period  
  private isInInitializationGracePeriod(): boolean {
    if (this.isInitialLoad) return true;
    
    const timeSinceInit = Date.now() - this.initializationCompleteTime;
    const gracePeriod = 2000; // 2 seconds grace period
    
    if (timeSinceInit < gracePeriod) {
      this.debugLog(`⏳ Still in initialization grace period (${timeSinceInit}ms < ${gracePeriod}ms)`);
      return true;
    }
    
    return false;
  }

  // Check if we should prevent duplicate redirection triggers
  private shouldPreventDuplicateRedirection(): boolean {
    const timeSinceLastTrigger = Date.now() - this.lastRedirectionTriggerTime;
    const duplicatePreventionWindow = 500; // 500ms window to prevent duplicates
    
    if (timeSinceLastTrigger < duplicatePreventionWindow) {
      this.debugLog(`🚫 Preventing duplicate redirection (${timeSinceLastTrigger}ms < ${duplicatePreventionWindow}ms)`);
      return true;
    }
    
    return false;
  }

  // Trigger redirection with duplicate prevention (optimized for speed)
  private triggerRedirection(source: string) {
    if (this.shouldPreventDuplicateRedirection()) {
      return;
    }
    
    this.lastRedirectionTriggerTime = Date.now();
    this.debugLog(`⚡ ${source} triggered fast search redirection`);
    
    // Reduced delay from 100ms to 10ms for faster response
    setTimeout(() => {
      this.handleSearchCommandExecution();
    }, 10);
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
    if (this.settings.autoPinSearchTab) {
      leaf.setPinned(true);
    }

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

  // Handle layout changes - focus on new search view detection
  private handleLayoutChanges = async () => {
    // Clear location cache when layout changes
    this.clearLocationCache();
    
    // Early exit if redirection is not enabled
    if (!this.settings.openBookmarksInMainArea) {
      return;
    }
    
    const leaves = this.app.workspace.getLeavesOfType("search");
    
    // Early exit if no search views exist
    if (leaves.length === 0) {
      return;
    }
    
    // Only process new search leaves during layout changes
    for (const leaf of leaves) {
      if (!this.processedLeaves.has(leaf)) {
        await this.processNewSearchLeaf(leaf);
      }
    }
  };

  // Handle active leaf changes - focus on existing search view activation
  private handleActiveLeafChanges = async () => {
    const activeLeaf = this.app.workspace.activeLeaf;
    
    // Early exit if not a search view or redirection not enabled
    if (!activeLeaf || 
        activeLeaf.view?.getViewType() !== "search" || 
        !this.settings.openBookmarksInMainArea) {
      return;
    }
    
    // Only check if this is a sidebar search that was just activated
    if (!this.isInMainArea(activeLeaf) && this.processedLeaves.has(activeLeaf)) {
      await this.handleExistingSearchLeafActivation(activeLeaf);
    }
  };

  // Process a newly detected search leaf
  private async processNewSearchLeaf(leaf: WorkspaceLeaf) {
    // Mark as processed immediately to avoid reprocessing
    this.processedLeaves.add(leaf);
    
    // Record creation time for immunity period
    this.leafCreationTime.set(leaf, Date.now());
    
    // 🎯 NEW: Skip redirection during initial plugin load or grace period
    if (this.isInInitializationGracePeriod()) {
      this.debugLog('📍 Skipping redirection during plugin initialization grace period');
      // Continue with normal processing (apply settings, start monitoring)
    } else {
      // Normal redirection logic for real bookmark clicks (after grace period)
      // 🎯 Check if bookmark redirection is enabled AND this is a sidebar search
      if (this.settings.openBookmarksInMainArea && !this.isInMainArea(leaf, true)) {
        this.debugLog('📍 New sidebar search detected via event system - redirecting to main area');
        
        // Use centralized redirection trigger with duplicate prevention
        this.triggerRedirection('Event system');
        
        // Don't apply settings or start monitoring - the leaf will be closed soon
        return;
      } else if (!this.isInMainArea(leaf, false)) {
        this.debugLog('📍 Sidebar search detected but redirection disabled by setting');
      }
    }
    
    // Apply saved settings if available (for both initial load and non-redirected leaves)
    if (this.settings.lastSearchState) {
      await this.applySettingsToNewLeaf(leaf);
    }
    
    // Start monitoring for user changes (with immunity period)
    this.startIntelligentMonitoring(leaf);
  };

  // Handle activation of existing sidebar search leaf (bookmark click on existing leaf)
  private async handleExistingSearchLeafActivation(leaf: WorkspaceLeaf) {
    this.debugLog('📍 Existing sidebar search leaf activated - checking for bookmark click redirection');
    
    // Apply same grace period and redirection logic as new leaves
    if (this.isInInitializationGracePeriod()) {
      this.debugLog('📍 Skipping activation redirection during plugin initialization grace period');
      return;
    }

    // Check if bookmark redirection is enabled AND this is a sidebar search
    if (this.settings.openBookmarksInMainArea && !this.isInMainArea(leaf, true)) {
      this.debugLog('📍 Existing sidebar search activated - redirecting to main area');
      
      // Use centralized redirection trigger with duplicate prevention
      this.triggerRedirection('Existing leaf activation');
    } else if (!this.isInMainArea(leaf, false)) {
      this.debugLog('📍 Existing sidebar search activated but redirection disabled by setting');
    }
  }

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

  // Set up command interception for keyboard shortcuts only
  setupCommandInterception() {
    this.debugLog('🎯 Setting up command interception for keyboard shortcuts');
    
    // Check if commands API exists
    const commands = (this.app as any).commands;
    if (!commands || !commands.executeCommand) {
      console.warn('⚠️ Commands API not found, command hooking disabled');
      return;
    }
    
    // Store the original executeCommand method
    this.originalExecuteCommand = commands.executeCommand.bind(commands);
    
    // Hook the executeCommand method
    commands.executeCommand = (commandId: string | any, ...args: any[]) => {
      // Enhanced logging for bookmark command detection
      const cmdId = typeof commandId === 'string' ? commandId : commandId?.id;
      const cmdName = typeof commandId === 'object' ? commandId?.name : '';
      
      this.debugLog('🔍 Command executed:', {
        id: cmdId,
        name: cmdName,
        fullObject: commandId,
        args: args,
        timestamp: Date.now(),
        context: 'bookmark-detection-mode'
      });
      
      // Extract actual command ID - it might be a string or an object with id property
      let actualCommandId: string;
      if (typeof commandId === 'string') {
        actualCommandId = commandId;
      } else if (commandId && typeof commandId === 'object' && commandId.id) {
        actualCommandId = commandId.id;
        this.debugLog('📎 Extracted command ID from object:', actualCommandId);
      } else {
        actualCommandId = '';
        this.debugWarn('⚠️ Unknown command format:', commandId);
      }
      
      // Execute the original command first
      const result = this.originalExecuteCommand!(commandId, ...args);
      
      // Check if this is a search-related command
      if (actualCommandId && this.isSearchCommand(actualCommandId)) {
        this.debugLog('🎯 Search command detected:', actualCommandId);
        
        // Clear all processed status for sidebar search views to allow reprocessing
        const currentSidebarSearchViews = this.app.workspace.getLeavesOfType("search")
          .filter(leaf => !this.isInMainArea(leaf));
        
        currentSidebarSearchViews.forEach(leaf => {
          if (this.processedLeaves.has(leaf)) {
            this.debugLog('🔄 Clearing processed status for existing sidebar search view');
            this.processedLeaves.delete(leaf);
          }
        });
        
        // Post-process immediately after command execution
        setTimeout(() => {
          this.debugLog('⚡ Immediate check (0ms delay)');
          this.handleSearchCommandExecution();
        }, 0);
      }
      
      return result;
    };
  }

  // Set up selective View State monitoring - only monitor leaves that could become search views
  setupViewStateMonitoring() {
    this.debugLog('👁️ Setting up selective View State monitoring');
    
    // Only monitor sidebar leaves (where search views might be created)
    this.app.workspace.iterateAllLeaves(leaf => {
      // Only monitor leaves in sidebar areas
      if (!this.isInMainArea(leaf)) {
        this.monitorLeafViewState(leaf);
      }
    });
    
    // Monitor new leaves when they are created in sidebar areas only
    this.registerEvent(
      this.app.workspace.on('layout-change', () => {
        // Clear cache first since layout changed
        this.clearLocationCache();
        
        this.app.workspace.iterateAllLeaves(leaf => {
          // Only monitor new sidebar leaves that aren't already monitored
          if (!this.isInMainArea(leaf) && !(leaf as any).__viewStateMonitored) {
            this.monitorLeafViewState(leaf);
          }
        });
      })
    );
  }

  // Monitor a specific leaf's setViewState method
  private monitorLeafViewState(leaf: WorkspaceLeaf) {
    // Avoid monitoring the same leaf multiple times
    if ((leaf as any).__viewStateMonitored) return;
    (leaf as any).__viewStateMonitored = true;
    
    const originalSetViewState = leaf.setViewState.bind(leaf);
    leaf.setViewState = async (viewState: any) => {
      this.debugLog('🔍 setViewState called:', {
        viewType: viewState?.type,
        isSearch: viewState?.type === 'search',
        leafLocation: this.isInMainArea(leaf) ? 'main' : 'sidebar',
        viewState: viewState
      });
      
      // 🎯 INTERCEPT: If this is setting a search view in sidebar and redirection is enabled
      if (viewState?.type === 'search' && !this.isInMainArea(leaf) && !this.isInInitializationGracePeriod()) {
        if (this.settings.openBookmarksInMainArea) {
          console.log('🚫 INTERCEPTING sidebar search creation - redirecting directly to main area');
          
          // Extract search state from the viewState
          const searchState = viewState?.state || {};
          const searchQuery = searchState?.query || "";
          
          // Create search tab in main area instead of allowing sidebar creation
          await this.createSearchTabInMainArea(String(searchQuery), searchState);
          
          console.log('✅ Direct redirection completed - sidebar search was never created');
          
          // Return a successful result without actually setting the sidebar view
          return Promise.resolve();
        } else {
          console.log('📍 Search view being set in sidebar but redirection disabled by setting');
        }
      } else if (viewState?.type === 'search' && !this.isInMainArea(leaf) && this.isInInitializationGracePeriod()) {
        console.log('📍 Skipping setViewState redirection during plugin initialization grace period');
      }
      
      // Execute the original setViewState for non-intercepted cases
      const result = await originalSetViewState(viewState);
      
      return result;
    };
  }

  // Complex API interception methods removed - using simple event-driven detection instead

  // Detect search views that were created directly without going through setViewState
  private detectDirectSearchViewCreation() {
    try {
      const allSearchLeaves = this.app.workspace.getLeavesOfType("search");
      const sidebarSearchLeaves = allSearchLeaves.filter(leaf => !this.isInMainArea(leaf));
      
      for (const leaf of sidebarSearchLeaves) {
        // Check if this leaf is newly created and not yet processed
        if (!this.processedLeaves.has(leaf) && !(leaf as any).__directDetected) {
          console.log('🔍 FALLBACK: Direct search view creation detected in sidebar');
          console.log('📍 Search view details:', {
            viewType: leaf.view?.getViewType?.(),
            leafLocation: 'sidebar',
            wasDirectlyCreated: true
          });
          
          // Mark as detected to avoid reprocessing
          (leaf as any).__directDetected = true;
          
          // Trigger redirection using the same logic
          setTimeout(() => {
            console.log('⚡ Fallback detection triggered search redirection');
            this.handleSearchCommandExecution();
          }, 0);
          
          break; // Only process one at a time to avoid conflicts
        }
      }
    } catch (error) {
      console.error('❌ Error in fallback detection:', error);
    }
  }

  // Check if a command is search-related
  private isSearchCommand(commandId: string): boolean {
    const searchCommands = [
      'global-search:open',     // ✅ Confirmed: Cmd+Shift+F triggers this
      'search-current-file',    // Possible current file search
      'search:toggle',          // Possible search toggle
      'search:open'             // Possible alternative search open
    ];
    
    const isSearchCommand = searchCommands.includes(commandId);
    if (isSearchCommand) {
      console.log('✅ Confirmed search command:', commandId);
    }
    
    return isSearchCommand;
  }

  // Handle post-processing after a search command is executed
  private handleSearchCommandExecution() {
    console.log('🔄 Processing search command execution');
    
    try {
      // Get all search views and their locations
      const allSearchLeaves = this.app.workspace.getLeavesOfType("search");
      console.log(`📊 Total search views found: ${allSearchLeaves.length}`);
      
      // Analyze each search view
      allSearchLeaves.forEach((leaf, index) => {
        const isMain = this.isInMainArea(leaf, false);
        const isProcessed = this.processedLeaves.has(leaf);
        console.log(`🔍 Search view ${index + 1}: ${isMain ? 'Main Area' : 'Sidebar'}, Processed: ${isProcessed}`);
      });
      
      // Find sidebar search views
      const sidebarSearchViews = allSearchLeaves.filter(leaf => !this.isInMainArea(leaf, false));
      console.log(`📍 Sidebar search views: ${sidebarSearchViews.length}`);
      
      // Find unprocessed sidebar search views
      const unprocessedSidebarViews = sidebarSearchViews.filter(leaf => !this.processedLeaves.has(leaf));
      console.log(`🆕 Unprocessed sidebar search views: ${unprocessedSidebarViews.length}`);
      
      // 🚨 TEMPORARY: Skip processed status check and force redirection
      if (sidebarSearchViews.length > 0) {
        const targetView = sidebarSearchViews[0];
        console.log('🎯 FORCED: Found sidebar search view, redirecting to main area (ignoring processed status)');
        this.redirectSidebarSearchToMainArea(targetView);
      } else {
        console.log('ℹ️ No sidebar search views found at all');
      }
    } catch (error) {
      console.error('❌ Error handling search command execution:', error);
    }
  }

  // Find recently created sidebar search views
  private findRecentSidebarSearchView(): WorkspaceLeaf | null {
    const searchLeaves = this.app.workspace.getLeavesOfType("search");
    const sidebarSearchLeaves = searchLeaves.filter(leaf => !this.isInMainArea(leaf));
    
    // Return the first unprocessed sidebar search view
    for (const leaf of sidebarSearchLeaves) {
      if (!this.processedLeaves.has(leaf)) {
        return leaf;
      }
    }
    
    return null;
  }

  // Detect sidebar search views and redirect them to main area
  private detectAndRedirectSidebarSearch() {
    if (!this.settings.openBookmarksInMainArea) return;
    
    const now = Date.now();
    // Prevent rapid successive redirections (cooldown period)
    if (now - this.lastRedirectionTime < 500) return;
    
    const searchLeaves = this.app.workspace.getLeavesOfType("search");
    const sidebarSearchLeaves = searchLeaves.filter(leaf => !this.isInMainArea(leaf));
    
    for (const leaf of sidebarSearchLeaves) {
      // Skip if we've already processed this leaf
      if (this.processedLeaves.has(leaf)) continue;
      
      console.log('🔄 Detected sidebar search view, redirecting:', {
        leaf: leaf,
        viewType: leaf?.view?.getViewType?.()
      });
      
      this.redirectSidebarSearchToMainArea(leaf);
      this.lastRedirectionTime = now;
      break; // Only redirect one at a time to avoid conflicts
    }
  }

  // Redirect a sidebar search view to main area with optimized speed
  private redirectSidebarSearchToMainArea(leaf: WorkspaceLeaf) {
    try {
      // Mark as processed to avoid reprocessing
      this.processedLeaves.add(leaf);
      
      console.log('🚀 Fast redirection: Optimizing sidebar to main area transition');
      
      // 🎯 IMMEDIATELY hide the sidebar search to prevent visual flicker
      try {
        const container = leaf.view?.containerEl;
        if (container) {
          container.style.display = 'none';
          console.log('👻 Sidebar search view hidden instantly');
        }
      } catch (error) {
        console.warn('Could not hide sidebar search view:', error);
      }
      
      // Get the search state quickly
      const viewState = leaf.getViewState();
      const searchState = viewState?.state;
      const searchQuery = searchState?.query || "";
      
      console.log('📋 Redirecting search query:', searchQuery);
      
      // Create in main area - force creation of new tab (async but don't wait)
      this.createSearchTabInMainArea(String(searchQuery), searchState);
      
      // Close the sidebar version as quickly as possible (reduced to 10ms)
      setTimeout(() => {
        try {
          console.log('🗑️ Closing hidden sidebar search view');
          leaf.detach();
        } catch (error) {
          console.warn('Could not detach sidebar search leaf:', error);
        }
      }, 10);
      
    } catch (error) {
      console.error('Error redirecting sidebar search:', error);
    }
  }

  // Create a new search tab in main area (similar to openPinnedSearchWithLastState)
  private async createSearchTabInMainArea(query: string, searchState?: any) {
    try {
      console.log('📝 Creating search tab with query:', query);
      
      // Create a new main-area tab
      const leaf = this.app.workspace.getLeaf("tab");
      
      // Build the view state
      const finalState = searchState || {};
      if (query) {
        finalState.query = query;
      }
      
      const viewState = {
        type: "search",
        active: true,
        state: finalState
      };
      
      console.log('🎯 Setting view state:', viewState);
      await leaf.setViewState(viewState);

      // Pin the tab if auto-pin is enabled
      if (this.settings.autoPinSearchTab) {
        leaf.setPinned(true);
      }

      // Reveal and focus the new tab
      this.app.workspace.revealLeaf(leaf);
      
      // Focus the search input
      setTimeout(() => {
        try {
          const input = leaf.view?.containerEl?.querySelector<HTMLInputElement>("input[type='search'], .workspace-leaf-content input");
          input?.focus();
        } catch {}
      }, 50);
      
      console.log('✅ Search tab created in main area');
      
    } catch (error) {
      console.error('❌ Failed to create search tab in main area:', error);
    }
  }



  // Check if a search view should be redirected to main area
  private shouldRedirectSearchView(leaf: WorkspaceLeaf): boolean {
    // Don't redirect if already in main area
    if (this.isInMainArea(leaf)) return false;
    
    // Don't redirect if this is one of our processed leaves (to avoid loops)
    if (this.processedLeaves.has(leaf)) return false;
    
    // Redirect if it's in sidebar or other non-main areas
    return true;
  }

  // Check if a leaf is in the main area with caching for better performance
  private isInMainArea(leaf: WorkspaceLeaf, enableVerboseLogging = false): boolean {
    // Check cache first
    const cachedResult = this.leafLocationCache.get(leaf);
    if (cachedResult !== undefined) {
      if (enableVerboseLogging) {
        console.log(`${cachedResult ? '🏠' : '📍'} Leaf location (cached): ${cachedResult ? 'Main Area' : 'Sidebar'}`);
      }
      return cachedResult;
    }
    
    // Check if the leaf is in the root split (main area)
    let parent = leaf.parent;
    let depth = 0;
    const parentChain = [];
    
    while (parent && depth < 10) { // Prevent infinite loops
      const parentType = (parent as any).type || parent.constructor.name || 'unknown';
      parentChain.push(parentType);
      if (parent === this.app.workspace.rootSplit) {
        // Cache the result
        this.leafLocationCache.set(leaf, true);
        
        if (enableVerboseLogging) {
          console.log(`🏠 Leaf is in main area (depth: ${depth}, chain: ${parentChain.join(' -> ')})`);
        }
        return true;
      }
      parent = parent.parent;
      depth++;
    }
    
    // Cache the result
    this.leafLocationCache.set(leaf, false);
    
    if (enableVerboseLogging) {
      console.log(`📍 Leaf is in sidebar (depth: ${depth}, chain: ${parentChain.join(' -> ')})`);
    }
    return false;
  }

  // Clear location cache when layout changes
  private clearLocationCache() {
    this.leafLocationCache = new WeakMap();
  }

  // Open search in main area with specific query and state
  private async openSearchInMainArea(query: string, searchState?: any) {
    try {
      // Prevent duplicate opens within a short time window
      const now = Date.now();
      if (this.lastBookmarkClick && 
          this.lastBookmarkClick.query === query && 
          now - this.lastBookmarkClick.timestamp < 1000) {
        console.log('Preventing duplicate bookmark click within 1 second');
        return;
      }
      
      this.lastBookmarkClick = { query, timestamp: now };
      
      console.log('Opening search in main area with query:', query);
      
      // Use provided search state or create one with the query
      const finalSearchState = searchState || {
        // Merge with saved settings if available
        ...(this.settings.lastSearchState || {}),
        // Override query with provided query
        query: query
      };
      
      console.log('Search state to be applied:', finalSearchState);
      
      // Create new tab in main area
      const leaf = this.app.workspace.getLeaf('tab');
      
      // Set up search view
      await leaf.setViewState({
        type: 'search',
        active: true,
        state: finalSearchState
      });

      // Pin the tab if auto-pin is enabled
      if (this.settings.autoPinSearchTab) {
        leaf.setPinned(true);
      }

      // Focus the new tab
      this.app.workspace.revealLeaf(leaf);
      
      // Show confirmation notice
      new Notice(`Search opened in main area: "${query}"`);
      
      this.debugLog('Successfully opened search in main area');
      
    } catch (error) {
      console.error('Failed to open search in main area:', error);
      new Notice('Failed to open search in main area');
    }
  }

  // Set up startup cleanup to run after workspace is ready
  private setupStartupCleanup() {
    this.debugLog('🧹 Setting up startup cleanup to run after workspace is ready');
    
    // Use onLayoutReady to ensure workspace is fully loaded
    this.app.workspace.onLayoutReady(() => {
      this.debugLog('🚀 Workspace layout ready - performing startup cleanup');
      this.performStartupCleanup();
    });
  }

  // Perform the actual startup cleanup
  private performStartupCleanup() {
    try {
      const searchLeaves = this.app.workspace.getLeavesOfType("search");
      const sidebarSearchLeaves = searchLeaves.filter(leaf => !this.isInMainArea(leaf));
      
      console.log(`🔍 Startup cleanup: Found ${searchLeaves.length} total search views, ${sidebarSearchLeaves.length} in sidebar`);
      
      if (sidebarSearchLeaves.length > 0) {
        console.log(`🧹 Clearing ${sidebarSearchLeaves.length} sidebar search view(s) on startup`);
        
        for (const leaf of sidebarSearchLeaves) {
          try {
            console.log('🗑️ Detaching sidebar search view');
            leaf.detach();
          } catch (error) {
            console.warn('Could not detach sidebar search leaf on startup:', error);
          }
        }
        
        console.log('✅ Startup sidebar search cleanup completed');
      } else {
        console.log('ℹ️ No sidebar search views found - no cleanup needed');
      }
    } catch (error) {
      console.error('❌ Error during startup cleanup:', error);
    }
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
      .setName("Auto-pin search tabs")
      .setDesc("Automatically pin search tabs when opening them in the main area. If disabled, tabs can be manually pinned later.")
      .addToggle(toggle => {
        toggle
          .setValue(this.plugin.settings.autoPinSearchTab)
          .onChange(async (value) => {
            this.plugin.settings.autoPinSearchTab = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Open search bookmarks in main area")
      .setDesc("When enabled, clicking search bookmarks will open them in a new tab in the main area instead of the sidebar.")
      .addToggle(toggle => {
        toggle
          .setValue(this.plugin.settings.openBookmarksInMainArea)
          .onChange(async (value) => {
            this.plugin.settings.openBookmarksInMainArea = value;
            await this.plugin.saveSettings();
            
            // Set up or remove command hooking based on setting
            if (value) {
              this.plugin.setupCommandInterception();
              new Notice("Search command hooking enabled");
            } else {
              new Notice("Search command hooking disabled - restart plugin to fully disable");
            }
          });
      });

    new Setting(containerEl)
      .setName("Clear sidebar search on startup")
      .setDesc("When enabled, any existing sidebar search views will be automatically closed when Obsidian starts up.")
      .addToggle(toggle => {
        toggle
          .setValue(this.plugin.settings.clearSidebarSearchOnStartup)
          .onChange(async (value) => {
            this.plugin.settings.clearSidebarSearchOnStartup = value;
            await this.plugin.saveSettings();
            
            if (value) {
              new Notice("Sidebar search will be cleared on startup");
            } else {
              new Notice("Sidebar search will persist on startup");
            }
          });
      });

    new Setting(containerEl)
      .setName("Debug mode")
      .setDesc("When enabled, detailed console logs will be shown for debugging purposes. Disable for cleaner console output.")
      .addToggle(toggle => {
        toggle
          .setValue(this.plugin.settings.debugMode)
          .onChange(async (value) => {
            this.plugin.settings.debugMode = value;
            await this.plugin.saveSettings();
            
            if (value) {
              new Notice("Debug mode enabled - detailed logs will be shown");
            } else {
              new Notice("Debug mode disabled - logs will be suppressed");
            }
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