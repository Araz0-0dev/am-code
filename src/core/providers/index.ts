import { ModelConfig, Provider } from '../types';
import { AnthropicProvider } from './anthropic';
import { OpenAiCompatibleProvider } from './openai';

let factory: (model: ModelConfig) => Provider = (model) =>
  model.provider === 'anthropic' ? new AnthropicProvider() : new OpenAiCompatibleProvider();

/** Test seam: lets the unit tests inject a scripted provider. */
export function setProviderFactory(next: (model: ModelConfig) => Provider): void {
  factory = next;
}

export function createProvider(model: ModelConfig): Provider {
  return factory(model);
}

export { AnthropicProvider, OpenAiCompatibleProvider };
export { buildHeaders, joinUrl, parseArgs } from './openai';
