import { App, Editor, MarkdownView, Modal, Notice, Plugin, PluginSettingTab, Setting, TFile, TFolder, requestUrl, normalizePath, ItemView, WorkspaceLeaf, setIcon } from 'obsidian';

// --- CONSTANTS & SETTINGS ---
const LOG_VIEW_TYPE = "llm-sort-log-view";

interface LLMSortSettings {
	llmBackend: 'ollama' | 'lmstudio';
	ollamaHost: string;
	lmStudioHost: string;
	modelName: string;
	inboxPath: string;
	autoSortEnabled: boolean;
	autoSortInterval: number;
}

const DEFAULT_SETTINGS: LLMSortSettings = {
	llmBackend: 'ollama',
	ollamaHost: 'http://localhost:11434',
	lmStudioHost: 'http://localhost:1234',
	modelName: 'llama3',
	inboxPath: '00_Inbox',
	autoSortEnabled: false,
	autoSortInterval: 60
}

interface LogEntry {
	timestamp: Date;
	filename: string;
	oldPath: string;
	newPath: string;
	reason: string;
	status: 'success' | 'error' | 'skipped';
}

// --- LOG VIEW (RIGHT SIDEBAR) ---
class LLMSortLogView extends ItemView {
	plugin: LLMSortPlugin;
	container: Element;

	constructor(leaf: WorkspaceLeaf, plugin: LLMSortPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType() {
		return LOG_VIEW_TYPE;
	}

	getDisplayText() {
		return "LLM Sort History";
	}

	getIcon() {
		return "history";
	}

	async onOpen() {
		const container = this.containerEl.children[1];
		container.empty();
		container.createEl("h4", { text: "Sorting Activity Log" });
		
		const listContainer = container.createDiv({ cls: "llm-sort-log-list" });
		this.container = listContainer;
		this.refresh();
	}

	async onClose() {
		// Nothing to clean up
	}

	refresh() {
		if (!this.container) return;
		this.container.empty();

		const logs = this.plugin.sortHistory.slice().reverse(); // Show newest first
		
		if (logs.length === 0) {
			this.container.createDiv({ text: "No activity yet.", cls: "llm-sort-empty-state" });
			return;
		}

		for (const log of logs) {
			const item = this.container.createDiv({ cls: "llm-sort-log-item" });
			
			// Header: Icon + Filename
			const header = item.createDiv({ cls: "llm-sort-log-header" });
			const iconSpan = header.createSpan({ cls: "llm-sort-status-icon" });
			if (log.status === 'success') setIcon(iconSpan, "check-circle");
			else if (log.status === 'error') setIcon(iconSpan, "alert-circle");
			else setIcon(iconSpan, "minus-circle");
			
			header.createSpan({ text: log.filename, cls: "llm-sort-filename" });
			header.createSpan({ text: log.timestamp.toLocaleTimeString(), cls: "llm-sort-time" });

			// Details
			if (log.status === 'success') {
				const details = item.createDiv({ cls: "llm-sort-log-details" });
				details.createDiv({ text: `📂 ${log.newPath}`, cls: "llm-sort-path" });
				details.createDiv({ text: `💡 ${log.reason}`, cls: "llm-sort-reason" });
			} else {
				item.createDiv({ text: log.reason, cls: "llm-sort-error-msg" });
			}
			
			item.style.marginBottom = "10px";
			item.style.padding = "8px";
			item.style.border = "1px solid var(--background-modifier-border)";
			item.style.borderRadius = "6px";
		}
	}
}

// --- MAIN PLUGIN CLASS ---
export default class LLMSortPlugin extends Plugin {
	settings: LLMSortSettings;
	autoSortIntervalId: number | null = null;
	sortHistory: LogEntry[] = [];
	logView: LLMSortLogView | null = null;

	async onload() {
		await this.loadSettings();

		// Register View
		this.registerView(
			LOG_VIEW_TYPE,
			(leaf) => (this.logView = new LLMSortLogView(leaf, this))
		);

		// Ribbon Icon
		this.addRibbonIcon('brain-circuit', 'LLM Sort Inbox', async (evt: MouseEvent) => {
			this.activateView(); // Open the log view
			await this.processInbox();
		});

		// Commands
		this.addCommand({
			id: 'process-inbox-llm',
			name: 'Process Inbox Now',
			callback: async () => {
				this.activateView();
				await this.processInbox();
			}
		});

		this.addCommand({
			id: 'show-llm-history',
			name: 'Show Sorting History',
			callback: async () => {
				this.activateView();
			}
		});

		this.addCommand({
			id: 'split-current-note',
			name: 'Split Current Note',
			editorCallback: async (editor: Editor, view: MarkdownView) => {
				await this.splitCurrentNote(view);
			}
		});

		// Settings Tab
		this.addSettingTab(new LLMSortSettingTab(this.app, this));

		// Auto Sort
		if (this.settings.autoSortEnabled) {
			this.startAutoSort();
		}
	}

	onunload() {
		this.stopAutoSort();
	}

	async activateView() {
		const { workspace } = this.app;
		let leaf: WorkspaceLeaf | null = null;
		const leaves = workspace.getLeavesOfType(LOG_VIEW_TYPE);

		if (leaves.length > 0) {
			// A leaf with our view already exists, use that
			leaf = leaves[0];
		} else {
			// Our view could not be found in the workspace, create a new leaf
			// in the right sidebar for it
			leaf = workspace.getRightLeaf(false);
			if (leaf) await leaf.setViewState({ type: LOG_VIEW_TYPE, active: true });
		}

		// "Reveal" the leaf in case it is in a collapsed sidebar
		if (leaf) workspace.revealLeaf(leaf);
	}

	addLog(entry: LogEntry) {
		this.sortHistory.push(entry);
		// Keep history manageable
		if (this.sortHistory.length > 100) this.sortHistory.shift();
		
		// Refresh view if active
		if (this.logView) {
			this.logView.refresh();
		}
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
		if (this.settings.autoSortEnabled) {
			this.startAutoSort();
		} else {
			this.stopAutoSort();
		}
	}

	startAutoSort() {
		this.stopAutoSort();
		this.autoSortIntervalId = window.setInterval(() => {
			this.processInbox(true); // Silent mode
		}, this.settings.autoSortInterval * 1000);
	}

	stopAutoSort() {
		if (this.autoSortIntervalId) {
			window.clearInterval(this.autoSortIntervalId);
			this.autoSortIntervalId = null;
		}
	}

	// --- CORE LOGIC ---

	async processInbox(silent = false) {
		const inboxPath = normalizePath(this.settings.inboxPath);
		const inboxFolder = this.app.vault.getAbstractFileByPath(inboxPath);
		
		if (!inboxFolder || !(inboxFolder instanceof TFolder)) {
			if (!silent) new Notice(`Inbox folder '${inboxPath}' not found! Please check settings.`);
			return;
		}

		// Get only direct children that are MD files
		const files = inboxFolder.children.filter(f => f instanceof TFile && f.extension === 'md');
		
		if (files.length === 0) {
			if (!silent) new Notice('Inbox is empty.');
			return;
		}

		if (!silent) new Notice(`Processing ${files.length} files...`);

		const structure = this.getVaultStructure();
		const engine = new ThinkingEngine(this.settings);

		for (const file of files) {
			if (!(file instanceof TFile)) continue;
			
			// SAFETY CHECK: Ensure file is ACTUALLY in the inbox
			if (normalizePath(file.parent?.path || "") !== inboxPath) {
				console.warn(`Skipping file ${file.name} because it is not in the inbox root.`);
				continue;
			}

			const content = await this.app.vault.read(file);
			
			// Simple heuristic: skip if empty or extremely short
			if (content.trim().length < 10) continue;

			try {
				const decision = await engine.classifyFile(content, structure);
				let targetFolder = decision.action === 'route' ? decision.target_folder : decision.suggested_folder;
				
				// Fallback
				if (!targetFolder) targetFolder = decision.fallback_folder || 'Unsorted';
				
				// Clean path
				targetFolder = normalizePath(targetFolder);

				// Double check we aren't moving to the same place (Inbox)
				if (targetFolder === inboxPath) {
					this.addLog({
						timestamp: new Date(),
						filename: file.name,
						oldPath: file.path,
						newPath: file.path,
						reason: "LLM suggested keeping in Inbox (skipped).",
						status: 'skipped'
					});
					continue;
				}

				await this.moveFileSafely(file, targetFolder, decision.reason);
				
			} catch (e) {
				console.error(`Failed to process ${file.name}:`, e);
				this.addLog({
					timestamp: new Date(),
					filename: file.name,
					oldPath: file.path,
					newPath: "N/A",
					reason: `Error: ${e.message}`,
					status: 'error'
				});
			}
		}

		if (!silent) new Notice('Inbox processing complete.');
	}

	async moveFileSafely(file: TFile, targetFolderPath: string, reason: string) {
		let finalFolderPath = targetFolderPath;
		
		// 1. Resolve Case-Insensitivity to prevent duplicate folder creation
		// (e.g., if "Notes" exists, don't create "notes")
		const existingFolder = this.findCaseInsensitiveFolder(targetFolderPath);
		if (existingFolder) {
			finalFolderPath = existingFolder.path;
		} else {
			// Folder doesn't exist, create it
			try {
				await this.app.vault.createFolder(finalFolderPath);
			} catch (e) {
				// Ignore error if it already exists (race condition)
			}
		}

		// 2. Determine new path
		const newPath = normalizePath(`${finalFolderPath}/${file.name}`);
		
		// 3. Move
		try {
			await this.app.fileManager.renameFile(file, newPath);
			
			this.addLog({
				timestamp: new Date(),
				filename: file.name,
				oldPath: file.path,
				newPath: finalFolderPath,
				reason: reason,
				status: 'success'
			});
			
		} catch (e) {
			throw new Error(`Move failed: ${e.message}`);
		}
	}

	findCaseInsensitiveFolder(path: string): TFolder | null {
		const parts = path.split('/');
		let currentPath = "";
		let currentFolder = this.app.vault.getRoot();
		
		// This is a naive check; for full path matching we'd walk the tree
		// But Obsidian's getAbstractFileByPath is case-sensitive.
		// Let's iterate all folders and check.
		// Note: This might be slow for huge vaults, but safer.
		
		const allFolders = this.app.vault.getAllLoadedFiles().filter(f => f instanceof TFolder) as TFolder[];
		const match = allFolders.find(f => f.path.toLowerCase() === path.toLowerCase());
		return match || null;
	}

	getVaultStructure(): string[] {
		const folders: string[] = [];
		const inboxPathClean = normalizePath(this.settings.inboxPath);
		const ignore = ['.git', '.obsidian', '.trash', 'System', inboxPathClean];
		
		const processFolder = (folder: TFolder) => {
			if (ignore.some(i => folder.path.includes(i))) return;
			folders.push(folder.path);
			for (const child of folder.children) {
				if (child instanceof TFolder) processFolder(child);
			}
		};

		processFolder(this.app.vault.getRoot());
		return folders;
	}

	async splitCurrentNote(view: MarkdownView) {
		const content = view.getViewData();
		if (!content) return;

		new Notice('Analyzing note for splitting...');
		const engine = new ThinkingEngine(this.settings);
		
		// Regex split by headers
		const chunks = content.split(/(?=^#{1,6} )/gm).filter(c => c.trim().length > 0);
		const allFiles = this.app.vault.getFiles().map(f => f.name);
		
		this.activateView(); // Show logs

		for (const chunk of chunks) {
			if (chunk.trim().length < 50) continue; // Skip tiny chunks

			try {
				const result = await engine.splitNote(chunk, allFiles.slice(0, 200));
				let filename = result.filename;
				if (!filename.endsWith('.md')) filename += '.md';
				
				// Sanitize filename
				filename = filename.replace(/[\\/:]/g, '-');
				
				await this.app.vault.create(filename, chunk);
				
				this.addLog({
					timestamp: new Date(),
					filename: "Current Note Chunk",
					oldPath: "Active Note",
					newPath: filename,
					reason: `Split created new note. Confidence: ${result.confidence}`,
					status: 'success'
				});
				
			} catch (e) {
				console.error('Error splitting chunk:', e);
				this.addLog({
					timestamp: new Date(),
					filename: "Chunk",
					oldPath: "Active Note",
					newPath: "N/A",
					reason: "Failed to process chunk",
					status: 'error'
				});
			}
		}
	}
}

// --- LLM ENGINE (UNCHANGED LOGIC, JUST RE-INCLUDED FOR COMPLETENESS) ---
class ThinkingEngine {
	settings: LLMSortSettings;

	constructor(settings: LLMSortSettings) {
		this.settings = settings;
	}

	async chat(messages: any[], jsonMode = true): Promise<string> {
		const url = this.settings.llmBackend === 'ollama' 
			? `${this.settings.ollamaHost}/api/chat`
			: `${this.settings.lmStudioHost}/v1/chat/completions`;

		const body: any = {
			model: this.settings.modelName,
			messages: messages,
			stream: false,
			temperature: 0.1,
		};

		if (this.settings.llmBackend === 'ollama' && jsonMode) {
			body.format = 'json';
		}

		try {
			const response = await requestUrl({
				url: url,
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(body)
			});

			if (response.status !== 200) throw new Error(`LLM Error: ${response.status}`);
			
			const data = response.json;
			if (data.message?.content) return data.message.content;
			if (data.choices?.[0]?.message?.content) return data.choices[0].message.content;
			
			throw new Error('Unknown response format');
		} catch (e) {
			console.error('LLM Call failed:', e);
			throw e;
		}
	}

	async classifyFile(content: string, folders: string[]): Promise<any> {
		const prompt = `
        You are an intelligent file sorter.
        EXISTING FOLDERS:
        ${JSON.stringify(folders)}
        
        TASK:
        Classify this note into an EXISTING folder if possible.
        If it requires a NEW folder, suggest a specific, descriptive name (e.g. "Projects/Python" instead of just "Python").
        
        RULES:
        1. PREFER EXISTING FOLDERS.
        2. DO NOT use generic names like "Notes" or "General".
        3. If specific topic matches an existing folder, use it.
        
        Return JSON ONLY:
        {
            "action": "route" or "suggest_new",
            "target_folder": "exact path from list",
            "suggested_folder": "new path",
            "fallback_folder": "closest match",
            "reason": "short explanation"
        }
        
        CONTENT:
        ${content.substring(0, 1500)}
        `;

		const response = await this.chat([
			{ role: 'system', content: 'You are a JSON-only API. Output strictly valid JSON.' },
			{ role: 'user', content: prompt }
		]);

		return this.extractJson(response);
	}

	async splitNote(chunk: string, existingFiles: string[]): Promise<any> {
		const prompt = `
        TASK: Give this text chunk a filename.
        FILES: ${JSON.stringify(existingFiles)}
        CHUNK: ${chunk.substring(0, 500)}
        
        Return JSON: { "filename": "Name.md", "confidence": 0.9 }
        `;

		const response = await this.chat([
			{ role: 'system', content: 'You are a JSON-only API.' },
			{ role: 'user', content: prompt }
		]);

		return this.extractJson(response);
	}

	extractJson(text: string): any {
		try {
			return JSON.parse(text);
		} catch {
			const match = text.match(/```json\s*([\s\S]*?)\s*```/) || text.match(/\{[\s\S]*\}/);
			if (match) {
				try { return JSON.parse(match[1] || match[0]); } catch { return {}; }
			}
			return {};
		}
	}
}

class LLMSortSettingTab extends PluginSettingTab {
	plugin: LLMSortPlugin;

	constructor(app: App, plugin: LLMSortPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		
		new Setting(containerEl)
			.setName('Inbox Folder')
			.setDesc('Path relative to vault root (e.g., "00_Inbox"). FILES OUTSIDE THIS FOLDER WILL NOT BE TOUCHED.')
			.addText(text => text
				.setValue(this.plugin.settings.inboxPath)
				.onChange(async (value) => {
					this.plugin.settings.inboxPath = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('LLM Backend')
			.addDropdown(dropdown => dropdown
				.addOption('ollama', 'Ollama')
				.addOption('lmstudio', 'LM Studio')
				.setValue(this.plugin.settings.llmBackend)
				.onChange(async (value) => {
					this.plugin.settings.llmBackend = value as 'ollama' | 'lmstudio';
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Ollama Host')
			.addText(text => text
				.setValue(this.plugin.settings.ollamaHost)
				.onChange(async (value) => {
					this.plugin.settings.ollamaHost = value;
					await this.plugin.saveSettings();
				}));
				
		new Setting(containerEl)
			.setName('Model Name')
			.addText(text => text
				.setValue(this.plugin.settings.modelName)
				.onChange(async (value) => {
					this.plugin.settings.modelName = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Auto-Sort Enabled')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.autoSortEnabled)
				.onChange(async (value) => {
					this.plugin.settings.autoSortEnabled = value;
					await this.plugin.saveSettings();
				}));
		
		new Setting(containerEl)
			.setName('Auto-Sort Interval (s)')
			.addText(text => text
				.setValue(String(this.plugin.settings.autoSortInterval))
				.onChange(async (value) => {
					this.plugin.settings.autoSortInterval = Number(value);
					await this.plugin.saveSettings();
				}));
	}
}
