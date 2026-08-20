import { testSiteAvailability } from './site-tester.js';
import { isRequestScopedAvailabilityFailure } from './upstream-error-classification.js';

export async function testConfiguredSite({
  configService,
  siteId,
  testSite = testSiteAvailability
}) {
  const run = async () => {
    const site = configService.findSite(siteId);
    let result;
    try {
      result = await testSite(site, {
        testModel: configService.getState().proxy.testModel
      });
    } catch (error) {
      result = {
        ok: false,
        statusCode: error?.statusCode ?? null,
        message: error?.message ?? String(error),
        detail: error?.detail ?? null
      };
    }

    if (result.ok) {
      const updated = await configService.recordSiteAvailabilitySuccess(siteId, {
        statusCode: result.statusCode,
        message: result.message
      });
      if (updated.enabled) {
        await configService.setActiveSite(siteId);
      }
    } else {
      const details = {
        statusCode: result.statusCode,
        message: result.message,
        detail: result.detail
      };
      if (isRequestScopedAvailabilityFailure(result)) {
        await configService.recordSiteAvailabilityFailure(siteId, details);
      } else {
        await configService.recordSiteFailure(siteId, details);
      }
    }

    return result;
  };

  return typeof configService.runSiteAvailabilityCheck === 'function'
    ? configService.runSiteAvailabilityCheck(siteId, run)
    : run();
}
