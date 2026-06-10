import assert from 'node:assert/strict';
import test from 'node:test';

import { shouldPreserveEditorOnStateChange } from '../src/renderer/editor-preservation.js';

test('preserves a dirty new-site editor when request status updates arrive', () => {
  assert.equal(
    shouldPreserveEditorOnStateChange({
      formDirty: true,
      selectedSiteId: null,
      nextSites: [{ id: 'existing' }]
    }),
    true
  );
});

test('does not preserve the editor when the form is clean', () => {
  assert.equal(
    shouldPreserveEditorOnStateChange({
      formDirty: false,
      selectedSiteId: null,
      nextSites: [{ id: 'existing' }]
    }),
    false
  );
});

test('does not preserve a dirty editor if its selected site was deleted', () => {
  assert.equal(
    shouldPreserveEditorOnStateChange({
      formDirty: true,
      selectedSiteId: 'deleted',
      nextSites: [{ id: 'other' }]
    }),
    false
  );
});
