import type { AccountModelPreferences, ModelPreference } from "../../accounts/model_preferences.js";
import type { CatalogSnapshot } from "../../copilot/model_catalog.js";

export class PreferredModelManager {
  constructor(private readonly preferences: AccountModelPreferences) {}

  setPreferred(
    accountId: string,
    modelId: string,
    expectedRevision: number,
    catalog: CatalogSnapshot,
  ): ModelPreference {
    if (!catalog.models.some((model) => model.id === modelId)) {
      throw new Error("model not in catalog");
    }
    return this.preferences.set(accountId, {
      modelId,
      catalogGeneration: catalog.generation,
    }, expectedRevision);
  }
}
