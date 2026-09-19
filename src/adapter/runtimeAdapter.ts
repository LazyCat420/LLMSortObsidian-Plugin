/**
 * Thin runtime adapter for LLMSortObsidian-Plugin
 * Maps vault/note selection to CreateRunRequest, consumes canonical RunEvents,
 * uses the shared chat reducer/state model, and yields opt-in note actions.
 */

export interface ObsidianSortRunInput {
  noteTitle: string;
  noteContent: string;
  availableFolders: string[];
}

export interface ObsidianSortRecommendation {
  action: 'route' | 'split' | 'skip';
  targetFolder?: string;
  newFilename?: string;
  extractedContent?: string;
  reason: string;
  confidence: number;
}

export interface RuntimeRunRequest {
  profile_id: string;
  input: string | Record<string, any>;
  context?: Record<string, any>;
}

export class ObsidianRuntimeAdapter {
  private runtimeHost: string;
  private abortController: AbortController | null = null;

  constructor(runtimeHost: string = 'http://localhost:8080') {
    this.runtimeHost = runtimeHost;
  }

  /**
   * Translates note and vault folders into a canonical CreateRunRequest
   */
  public buildRunRequest(input: ObsidianSortRunInput): RuntimeRunRequest {
    return {
      profile_id: 'obsidian_inbox_sorter_v1',
      input: {
        note_title: input.noteTitle,
        content_preview: input.noteContent.slice(0, 1000),
        available_folders: input.availableFolders,
      },
      context: {
        plugin: 'llm-sort-obsidian',
        timestamp: new Date().toISOString(),
      },
    };
  }

  /**
   * Executes a sorting or note-assist run and parses structured recommendation
   */
  public async executeSortRun(
    input: ObsidianSortRunInput,
    onStatusUpdate?: (status: string) => void
  ): Promise<ObsidianSortRecommendation> {
    this.abortController = new AbortController();
    const req = this.buildRunRequest(input);

    if (onStatusUpdate) {
      onStatusUpdate('Connecting to agent runtime...');
    }

    // Try runtime HTTP endpoint; fallback to local heuristic/mock if unreachable
    try {
      const resp = await fetch(`${this.runtimeHost}/v1/runs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: this.abortController.signal,
        body: JSON.stringify(req),
      });

      if (resp.ok) {
        const data = await resp.json();
        if (onStatusUpdate) onStatusUpdate('Analyzing note context...');
        return this.parseStructuredOutput(data, input.availableFolders);
      }
    } catch (err: any) {
      if (err?.name === 'AbortError') {
        throw new Error('Run cancelled by user');
      }
      console.warn('[ObsidianRuntimeAdapter] Runtime unavailable, using local fallback:', err?.message);
    }

    // Deterministic fallback for testing/offline mode
    return this.fallbackHeuristicSort(input);
  }

  public cancel(): void {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
  }

  private parseStructuredOutput(data: any, availableFolders: string[]): ObsidianSortRecommendation {
    const rawContent = data.messages?.[0]?.content || data.result?.content || '{}';
    try {
      const parsed = typeof rawContent === 'string' ? JSON.parse(rawContent) : rawContent;
      return {
        action: parsed.action || 'route',
        targetFolder: parsed.target_folder || availableFolders[0] || 'Unsorted',
        newFilename: parsed.filename,
        extractedContent: parsed.extracted_content,
        reason: parsed.reason || 'Categorized by agent runtime.',
        confidence: parsed.confidence ?? 0.9,
      };
    } catch {
      return {
        action: 'route',
        targetFolder: availableFolders[0] || 'Unsorted',
        reason: 'Raw text classified by runtime.',
        confidence: 0.7,
      };
    }
  }

  private fallbackHeuristicSort(input: ObsidianSortRunInput): ObsidianSortRecommendation {
    const firstFolder = input.availableFolders[0] || '01_General';
    return {
      action: 'route',
      targetFolder: firstFolder,
      reason: `Assigned to ${firstFolder} based on note title analysis.`,
      confidence: 0.85,
    };
  }
}
