export function shouldPreserveEditorOnStateChange({
  formDirty,
  editorHasFocus = false,
  selectedSiteId,
  nextSites
}) {
  if (!formDirty && !editorHasFocus) {
    return false;
  }

  if (!selectedSiteId) {
    return true;
  }

  return nextSites.some((site) => site.id === selectedSiteId);
}
