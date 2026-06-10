import { isRequestScopedAvailabilityFailure } from './upstream-error-classification.js';

export async function recoverAvailableSites({ configService, testSite }) {
  const sites = configService
    .getState()
    .sites.filter((site) => site.manualEnabled && site.failureDisabled);
  const enabledSites = [];
  const failedSites = [];

  for (const site of sites) {
    const result = await testSite(site);

    if (result.ok) {
      const updated = await configService.recordSiteAvailabilitySuccess(site.id, {
        statusCode: result.statusCode,
        message: result.message
      });
      if (updated.enabled) {
        if (enabledSites.length === 0) {
          await configService.setActiveSite(site.id);
        }
        enabledSites.push(updated);
      }
    } else {
      const details = {
        statusCode: result.statusCode,
        message: result.message,
        detail: result.detail
      };
      const failed = isRequestScopedAvailabilityFailure(result)
        ? await configService.recordSiteAvailabilityFailure(site.id, details)
        : (await configService.recordSiteFailure(site.id, details)).site;
      failedSites.push(failed);
    }
  }

  return {
    site: enabledSites[0] ?? null,
    enabledSites,
    failedSites
  };
}
