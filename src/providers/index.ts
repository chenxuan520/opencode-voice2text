import type { VoiceProvider } from "./types.js"
import { volcengineProvider } from "./volcengine.js"

const providers: Record<string, VoiceProvider> = {
  [volcengineProvider.id]: volcengineProvider,
}

export function getProviderById(providerId: string): VoiceProvider {
  const provider = providers[providerId]
  if (!provider) {
    throw new Error(`Unsupported provider '${providerId}'. Available providers: ${Object.keys(providers).join(", ")}.`)
  }
  return provider
}

export function listProviderIds() {
  return Object.keys(providers)
}
