import type Database from "better-sqlite3";

export interface ModelPreference {
  readonly accountId: string;
  readonly revision: number;
  readonly modelId: string;
  readonly validity: "valid" | "invalid";
  readonly catalogGeneration: number;
}

export class PreferenceRevisionError extends Error {
  constructor(message = "model preference revision conflict") {
    super(message);
    this.name = "PreferenceRevisionError";
  }
}

export class AccountModelPreferences {
  constructor(
    private readonly database: Database.Database,
    private readonly nowMs: () => number = Date.now,
  ) {}

  get(accountId: string): ModelPreference | null {
    const row = this.database.prepare(
      "SELECT account_id, revision, model_id, validity, catalog_generation FROM account_model_preferences WHERE account_id = ?",
    ).get(accountId) as
      | { account_id: string; revision: number; model_id: string; validity: "valid" | "invalid"; catalog_generation: number }
      | undefined;
    if (row === undefined) {
      return null;
    }
    return {
      accountId: row.account_id,
      revision: row.revision,
      modelId: row.model_id,
      validity: row.validity,
      catalogGeneration: row.catalog_generation,
    };
  }

  set(
    accountId: string,
    candidate: Readonly<{ modelId: string; catalogGeneration: number }>,
    expectedRevision: number,
  ): ModelPreference {
    const current = this.get(accountId);
    const currentRevision = current?.revision ?? 0;
    if (currentRevision !== expectedRevision) {
      throw new PreferenceRevisionError();
    }
    const next: ModelPreference = {
      accountId,
      revision: expectedRevision + 1,
      modelId: candidate.modelId,
      validity: "valid",
      catalogGeneration: candidate.catalogGeneration,
    };
    this.database.prepare(
      `INSERT INTO account_model_preferences (account_id, revision, model_id, validity, catalog_generation, updated_at_ms)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(account_id) DO UPDATE SET
         revision = excluded.revision,
         model_id = excluded.model_id,
         validity = excluded.validity,
         catalog_generation = excluded.catalog_generation,
         updated_at_ms = excluded.updated_at_ms`,
    ).run(accountId, next.revision, next.modelId, next.validity, next.catalogGeneration, this.nowMs());
    return next;
  }

  markInvalidIfMissing(
    accountId: string,
    visibleModelIds: ReadonlySet<string>,
    catalogGeneration: number,
  ): ModelPreference | null {
    const current = this.get(accountId);
    if (current === null) {
      return null;
    }
    if (visibleModelIds.has(current.modelId)) {
      return current;
    }
    this.database.prepare(
      "UPDATE account_model_preferences SET validity = 'invalid', catalog_generation = ?, revision = revision + 1, updated_at_ms = ? WHERE account_id = ?",
    ).run(catalogGeneration, this.nowMs(), accountId);
    return this.get(accountId);
  }

  clear(accountId: string): void {
    this.database.prepare("DELETE FROM account_model_preferences WHERE account_id = ?").run(accountId);
  }
}
