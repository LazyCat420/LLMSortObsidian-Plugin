import { App, Editor, MarkdownView, Modal, Notice, Plugin, PluginSettingTab, Setting, TFile, TFolder, requestUrl, normalizePath } from 'obsidian';

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

export default class LLMSortPlugin extends Plugin {
	settings: LLMSortSettings;
	autoSortIntervalId: number | null = null;

	async onload() {
		await this.loadSettings();

		// Ribbon Icon
		this.addRibbonIcon('arrow-right-circle', 'Process Inbox', async (evt: MouseEvent) => {
			await this.processInbox();
		});

		// Commands
		this.addCommand({
			id: 'process-inbox',
			name: 'Process Inbox',
			callback: async () => {
				await this.processInbox();
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

	async processInbox(silent = false) {
		const inboxFolder = this.app.vault.getAbstractFileByPath(this.settings.inboxPath);
		if (!inboxFolder || !(inboxFolder instanceof TFolder)) {
			if (!silent) new Notice(`Inbox folder '${this.settings.inboxPath}' not found.`);
			return;
		}

		const files = inboxFolder.children.filter(f => f instanceof TFile && f.extension === 'md');
		if (files.length === 0) {
			if (!silent) new Notice('Inbox is empty.');
			return;
		}

		if (!silent) new Notice(`Processing ${files.length} files...`);

		const structure = this.getVaultStructure();
		const engine = new ThinkingEngine(this.settings);

		for (const file of files) {
			if (file instanceof TFile) {
				const content = await this.app.vault.read(file);
				
				// Optional: Check if finished (simple heuristic for now)
				if (content.length < 10) continue;

				try {
					const decision = await engine.classifyFile(content, structure);
					const targetFolder = decision.action === 'route' ? decision.target_folder : decision.suggested_folder;
					const finalFolder = targetFolder || decision.fallback_folder || 'Unsorted';

					await this.moveFile(file, finalFolder, decision.reason);
				} catch (e) {
					console.error(`Failed to process ${file.name}:`, e);
				}
			}
		}

		if (!silent) new Notice('Inbox processing complete.');
	}

	async moveFile(file: TFile, folderPath: string, reason: string) {
		const safeFolderPath = normalizePath(folderPath);
		// Create folder if not exists
		if (!this.app.vault.getAbstractFileByPath(safeFolderPath)) {
			await this.app.vault.createFolder(safeFolderPath);
		}

		const newPath = normalizePath(`${safeFolderPath}/${file.name}`);
		await this.app.fileManager.renameFile(file, newPath);
		console.log(`Moved ${file.name} to ${newPath}. Reason: ${reason}`);
	}

	getVaultStructure(): string[] {
		const folders: string[] = [];
		const ignore = ['.git', '.obsidian', '.trash', 'System', this.settings.inboxPath];
		
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
		
		// Regex split by headers (simple version)
		const chunks = content.split(/(?=^#{1,6} )/gm).filter(c => c.trim().length > 0);
		
		const allFiles = this.app.vault.getFiles().map(f => f.name);
		
		for (const chunk of chunks) {
			if (chunk.trim().length < 20) continue; // Skip tiny chunks

			try {
				const result = await engine.splitNote(chunk, allFiles.slice(0, 200)); // Limit context
				const filename = result.filename.endsWith('.md') ? result.filename : `${result.filename}.md`;
				
				// Create new file
				await this.app.vault.create(filename, chunk);
				new Notice(`Created: ${filename}`);
			} catch (e) {
				console.error('Error splitting chunk:', e);
				new Notice('Error processing a chunk.');
			}
		}
	}
}

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
			// Ollama
			if (data.message?.content) return data.message.content;
			// LM Studio / OpenAI
			if (data.choices?.[0]?.message?.content) return data.choices[0].message.content;
			
			throw new Error('Unknown response format');
		} catch (e) {
			console.error('LLM Call failed:', e);
			throw e;
		}
	}

	async classifyFile(content: string, folders: string[]): Promise<any> {
		const prompt = `
        You are an intelligent file sorter for a knowledge base.
        AVAILABLE FOLDERS:
        ${JSON.stringify(folders)}
        
        TASK:
        Determine where to file this note. PREFER SPECIFIC ORGANIZATION over generic dumping.
        
        RULES:
        1. If user explicitly named a folder that EXISTS -> action="route", use that folder
        2. If user explicitly named a folder that does NOT exist -> action="suggest_new", create it
        3. If an existing folder is a SPECIFIC semantic match -> action="route"
        4. If NO existing folder is a good match -> action="suggest_new" with a DESCRIPTIVE name
        5. ALWAYS provide a fallback_folder from AVAILABLE FOLDERS
        
        Return JSON ONLY:
        {
            "action": "route" or "suggest_new",
            "target_folder": "folder path",
            "suggested_folder": "new folder path",
            "fallback_folder": "existing folder path",
            "reason": "explanation"
        }
        
        FILE CONTENT (First 2000 chars):
        ${content.substring(0, 2000)}
        `;

		const response = await this.chat([
			{ role: 'system', content: 'You are a JSON-only API. Output strictly valid JSON.' },
			{ role: 'user', content: prompt }
		]);

		return this.extractJson(response);
	}

	async splitNote(chunk: string, existingFiles: string[]): Promise<any> {
		const prompt = `
        TASK: Route this note chunk to the best matching file.
        FILES: ${JSON.stringify(existingFiles)}
        CHUNK: ${chunk.substring(0, 1000)}
        
        Return JSON: { "filename": "Target.md", "reason": "..." }
        If no match, suggest a NEW filename.
        `;

		const response = await this.chat([
			{ role: 'system', content: 'You are a JSON-only API. Output strictly valid JSON.' },
			{ role: 'user', content: prompt }
		]);

		return this.extractJson(response);
	}

	extractJson(text: string): any {
		try {
			// Try direct parse
			return JSON.parse(text);
		} catch {
			// Extract from markdown code blocks
			const match = text.match(/```json\s*([\s\S]*?)\s*```/) || text.match(/\{[\s\S]*\}/);
			if (match) {
				try {
					return JSON.parse(match[1] || match[0]);
				} catch {
					return {};
				}
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
			.setName('LLM Backend')
			.setDesc('Choose between Ollama or LM Studio')
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
			.setDesc('Base URL for Ollama')
			.addText(text => text
				.setPlaceholder('http://localhost:11434')
				.setValue(this.plugin.settings.ollamaHost)
				.onChange(async (value) => {
					this.plugin.settings.ollamaHost = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('LM Studio Host')
			.setDesc('Base URL for LM Studio')
			.addText(text => text
				.setPlaceholder('http://localhost:1234')
				.setValue(this.plugin.settings.lmStudioHost)
				.onChange(async (value) => {
					this.plugin.settings.lmStudioHost = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Model Name')
			.setDesc('Name of the model to use (e.g., llama3, granite3.3)')
			.addText(text => text
				.setValue(this.plugin.settings.modelName)
				.onChange(async (value) => {
					this.plugin.settings.modelName = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Inbox Folder')
			.setDesc('Path to the folder to monitor')
			.addText(text => text
				.setValue(this.plugin.settings.inboxPath)
				.onChange(async (value) => {
					this.plugin.settings.inboxPath = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Auto-Sort Enabled')
			.setDesc('Automatically sort files in inbox')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.autoSortEnabled)
				.onChange(async (value) => {
					this.plugin.settings.autoSortEnabled = value;
					await this.plugin.saveSettings();
				}));
		
		new Setting(containerEl)
			.setName('Auto-Sort Interval (seconds)')
			.setDesc('How often to check the inbox')
			.addText(text => text
				.setValue(String(this.plugin.settings.autoSortInterval))
				.onChange(async (value) => {
					this.plugin.settings.autoSortInterval = Number(value);
					await this.plugin.saveSettings();
				}));
	}
}
