export function shouldPreserveEditorOnStateChange({ formDirty, selectedSiteId, nextSites }) {
  if (!formDirty) {
    return false;
  }

  if (!selectedSiteId) {
    return true;
  }

  return nextSites.some((site) => site.id === selectedSiteId);
}
