export const DEFAULT_MODEL_CREATED_AT_TIME = 1_677_610_602;

export interface CopilotCatalogModel {
  readonly id: string;
  readonly name: string;
  readonly vendor: string;
  readonly modelPickerEnabled: boolean;
  readonly routing?: {
    readonly mode?: string;
    readonly supportedEndpoints?: readonly string[];
  };
}

export interface CatalogSnapshot {
  readonly accountId: string;
  readonly models: readonly CopilotCatalogModel[];
  readonly fetchedAt: string;
  readonly generation: number;
}

export interface CapiModelsResponse {
  readonly data: readonly unknown[];
}

export interface CopilotModelsSource {
  fetch(accountId: string, signal: AbortSignal): Promise<CapiModelsResponse>;
}

export interface ModelInfoLookup {
  get(modelId: string): {
    readonly mode?: unknown;
    readonly max_input_tokens?: unknown;
    readonly max_output_tokens?: unknown;
    readonly supported_endpoints?: unknown;
  } | null;
}

interface CacheEntry {
  catalog: CatalogSnapshot;
  generation: number;
}

export class CopilotModelCatalog {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly generations = new Map<string, number>();

  constructor(
    private readonly source: CopilotModelsSource,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async get(accountId: string, signal: AbortSignal): Promise<CatalogSnapshot> {
    const hit = this.cache.get(accountId);
    if (hit !== undefined) {
      return hit.catalog;
    }
    const generation = this.generations.get(accountId) ?? 0;
    const raw = await this.source.fetch(accountId, signal);
    const models = parseCapiModels(raw);
    const fetchedAt = toRfc3339Nano(this.now());
    const catalog: CatalogSnapshot = { accountId, models, fetchedAt, generation };
    if ((this.generations.get(accountId) ?? 0) === generation) {
      this.cache.set(accountId, { catalog, generation });
    }
    return catalog;
  }

  invalidate(accountId: string): void {
    this.cache.delete(accountId);
    this.generations.set(accountId, (this.generations.get(accountId) ?? 0) + 1);
  }

  clear(): void {
    for (const accountId of new Set([...this.cache.keys(), ...this.generations.keys()])) {
      this.generations.set(accountId, (this.generations.get(accountId) ?? 0) + 1);
    }
    this.cache.clear();
  }
}

export function parseCapiModels(raw: CapiModelsResponse | unknown): CopilotCatalogModel[] {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw) || !("data" in raw)) {
    throw new Error("invalid CAPI models response");
  }
  const data = (raw as { data: unknown }).data;
  if (!Array.isArray(data)) {
    throw new Error("invalid CAPI models response");
  }
  const models: CopilotCatalogModel[] = [];
  for (const item of data) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      throw new Error("invalid CAPI model item");
    }
    const record = item as Record<string, unknown>;
    if (typeof record.id !== "string" || typeof record.name !== "string" || typeof record.vendor !== "string" || typeof record.model_picker_enabled !== "boolean") {
      throw new Error("invalid CAPI model item");
    }
    if (record.model_picker_enabled !== true) {
      continue;
    }
    models.push({
      id: record.id,
      name: record.name,
      vendor: record.vendor,
      modelPickerEnabled: true,
    });
  }
  return models;
}

export function toRfc3339Nano(date: Date): string {
  return date.toISOString().replace(/\.\d+Z$/u, "Z");
}

export function capiModelsUrl(endpoint: string): string {
  return `${endpoint}/models`;
}
