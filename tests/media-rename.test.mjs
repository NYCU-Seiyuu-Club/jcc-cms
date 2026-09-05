import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const registeredListeners = [];
const context = {
  CMS: {
    registerEventListener(listener) {
      registeredListeners.push(listener);
    },
  },
  console,
  fetch: () => Promise.reject(new Error('network access is not available in tests')),
  window: { localStorage: { getItem: () => null } },
};
context.window.window = context.window;

vm.runInNewContext(readFileSync(new URL('../media-rename.js', import.meta.url), 'utf8'), context);

const { planRenames } = context.window.JCCMediaRename;

// Objects returned from vm.runInNewContext belong to a different realm, so
// assert.deepEqual's prototype check fails even when the shapes match.
// Round-tripping through JSON normalizes them to this realm's Object/Array.
function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

test('names a freshly uploaded cover image and body images after the slug', () => {
  const body = '前情提要\n\n![](/images/announcements/IMG_1234.jpg)\n\n後記\n\n![](/images/announcements/IMG_1235.png)';
  const result = planRenames({
    slug: 'club-fair',
    coverImage: '/images/announcements/special.jpg',
    body,
  });

  assert.deepEqual(plain(result.renames), [
    { from: '/images/announcements/special.jpg', to: '/images/announcements/club-fair.jpg' },
    { from: '/images/announcements/IMG_1234.jpg', to: '/images/announcements/club-fair-2.jpg' },
    { from: '/images/announcements/IMG_1235.png', to: '/images/announcements/club-fair-3.png' },
  ]);
  assert.equal(result.nextCoverImage, '/images/announcements/club-fair.jpg');
  assert.match(result.nextBody, /club-fair-2\.jpg/);
  assert.match(result.nextBody, /club-fair-3\.png/);
});

test('is a no-op once everything already matches the slug (repeat saves)', () => {
  const body = '![](/images/announcements/club-fair-2.jpg)';
  const result = planRenames({
    slug: 'club-fair',
    coverImage: '/images/announcements/club-fair.jpg',
    body,
  });

  assert.deepEqual(plain(result.renames), []);
  assert.equal(result.nextCoverImage, '/images/announcements/club-fair.jpg');
  assert.equal(result.nextBody, body);
});

test('re-syncs images to a new slug without renumbering already-correct ones', () => {
  const body = '![](/images/announcements/old-slug-2.jpg) ![](/images/announcements/old-slug-3.png)';
  const result = planRenames({
    slug: 'new-slug',
    coverImage: '/images/announcements/old-slug.jpg',
    body,
  });

  assert.deepEqual(plain(result.renames), [
    { from: '/images/announcements/old-slug.jpg', to: '/images/announcements/new-slug.jpg' },
    { from: '/images/announcements/old-slug-2.jpg', to: '/images/announcements/new-slug-2.jpg' },
    { from: '/images/announcements/old-slug-3.png', to: '/images/announcements/new-slug-3.png' },
  ]);
});

test('ignores unmanaged paths and invalid slugs', () => {
  const external = planRenames({
    slug: 'club-fair',
    coverImage: 'https://example.com/photo.jpg',
    body: '![](https://example.com/other.jpg)',
  });
  assert.deepEqual(plain(external.renames), []);

  const invalidSlug = planRenames({
    slug: '尚未填寫',
    coverImage: '/images/announcements/special.jpg',
    body: '',
  });
  assert.deepEqual(plain(invalidSlug.renames), []);
  assert.equal(invalidSlug.nextCoverImage, '/images/announcements/special.jpg');
});

test('registers a preSave listener', () => {
  assert.equal(registeredListeners.length, 1);
  assert.equal(registeredListeners[0].name, 'preSave');
});
