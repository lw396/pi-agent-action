import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

/**
 * The model runtime the action uses: provider keys come from the environment
 * (or setRuntimeApiKey), every credential stays in memory, and only pi's
 * static model catalog is used.
 */
export async function createModelRuntime(): Promise<ModelRuntime> {
  return ModelRuntime.create({
    credentials: new InMemoryCredentialStore(), // never reads or writes auth.json
    modelsPath: null, // no models.json
    refreshOnCreate: false, // static catalog only, no network at startup
  });
}
