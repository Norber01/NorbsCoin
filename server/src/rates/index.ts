import { config } from '../config.js';
import { ManualOnlyProvider, OpenErApiProvider, type RateProvider } from './provider.js';

export function createRateProvider(): RateProvider {
  switch (config.rates.provider) {
    case 'open_er_api':
      return new OpenErApiProvider(config.rates.openErApiUrl, config.rates.timeoutMs);
    case 'manual':
      return new ManualOnlyProvider();
    default:
      throw new Error(`Unknown RATE_PROVIDER ${config.rates.provider}`);
  }
}
