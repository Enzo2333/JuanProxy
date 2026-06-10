import { testSiteAvailability } from './site-tester.js';
import { isRequestScopedAvailabilityFailure } from './upstream-error-classification.js';

export async function testConfiguredSite({
  configService,
  siteId,
  testSite = testSiteAvailability
}) {
  const site = configService.findSite(siteId);
  const result = await testSite(site);

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
}
