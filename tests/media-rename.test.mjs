import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const registeredListeners = [];
const alerts = [];
let fetchMock = () => Promise.reject(new Error('network access is not available in tests'));
const context = {
  CMS: {
    registerEventListener(listener) {
      registeredListeners.push(listener);
    },
  },
  console: { log: console.log, warn: console.warn, error: () => {} },
  fetch: (...args) => fetchMock(...args),
  TextDecoder,
  TextEncoder,
  Uint8Array,
  atob,
  btoa,
  window: {
    alert(message) {
      alerts.push(message);
    },
    localStorage: {
      getItem: () => JSON.stringify({ token: 'test-token' }),
    },
  },
};
context.window.window = context.window;

vm.runInNewContext(readFileSync(new URL('../media-rename.js', import.meta.url), 'utf8'), context);

const { planRenames, resolveEntryPath } = context.window.JCCMediaRename;

// Objects returned from vm.runInNewContext belong to a different realm, so
// assert.deepEqual's prototype check fails even when the shapes match.
// Round-tripping through JSON normalizes them to this realm's Object/Array.
function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function immutableMap(values) {
  return { get: key => values[key] };
}

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function createGitHubMock({ sourceStatus = 200, targetSha = null, entryStatus = 200 } = {}) {
  const requests = [];
  const entryText = [
    '---',
    'slug: test456',
    'coverImage: /images/announcements/sfa.png',
    '---',
    '測試內容',
  ].join('\n');

  const mock = async (url, options = {}) => {
    const request = { url, method: options.method || 'GET', body: options.body };
    requests.push(request);
    const path = new URL(url).pathname;

    if (path.endsWith('/git/ref/heads/main')) return jsonResponse({ object: { sha: 'base-commit' } });
    if (path.endsWith('/git/commits/base-commit')) return jsonResponse({ tree: { sha: 'base-tree' } });
    if (path.endsWith('/contents/src/data/announcements/test456.md')) {
      return entryStatus === 200
        ? jsonResponse({ content: Buffer.from(entryText).toString('base64') })
        : jsonResponse({ message: 'entry error' }, entryStatus);
    }
    if (path.endsWith('/contents/public/images/announcements/sfa.png')) {
      return sourceStatus === 200
        ? jsonResponse({ sha: 'source-image-blob' })
        : jsonResponse({ message: 'source missing' }, sourceStatus);
    }
    if (path.endsWith('/contents/public/images/announcements/test456.png')) {
      return targetSha
        ? jsonResponse({ sha: targetSha })
        : jsonResponse({ message: 'target missing' }, 404);
    }
    if (path.endsWith('/git/blobs')) return jsonResponse({ sha: 'entry-blob' }, 201);
    if (path.endsWith('/git/trees')) return jsonResponse({ sha: 'new-tree' }, 201);
    if (path.endsWith('/git/commits')) return jsonResponse({ sha: 'new-commit' }, 201);
    if (path.endsWith('/git/refs/heads/main')) return jsonResponse({ object: { sha: 'new-commit' } });

    throw new Error(`Unexpected request: ${request.method} ${url}`);
  };

  return { mock, requests };
}

function newAnnouncementEntry() {
  return immutableMap({
    collection: 'announcements',
    path: '',
    data: immutableMap({
      slug: 'test456',
      coverImage: '/images/announcements/sfa.png',
      body: '',
    }),
  });
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

test('supports legacy underscore slugs', () => {
  const result = planRenames({
    slug: 'hello_world',
    coverImage: '/images/announcements/special.jpg',
    body: '',
  });

  assert.deepEqual(plain(result.renames), [
    { from: '/images/announcements/special.jpg', to: '/images/announcements/hello_world.jpg' },
  ]);
});

test('resolves new entry paths from collection and keeps existing paths', () => {
  assert.equal(
    resolveEntryPath(immutableMap({ collection: 'announcements', path: '' }), 'test456'),
    'src/data/announcements/test456.md',
  );
  assert.equal(
    resolveEntryPath(immutableMap({ collection: 'journals', path: null }), 'trip-log'),
    'src/data/journals/trip-log.md',
  );
  assert.equal(
    resolveEntryPath(immutableMap({ collection: 'announcements', path: 'src/data/announcements/測試.md' }), 'new-slug'),
    'src/data/announcements/測試.md',
  );
});

test('postSave renames a new entry image even when Decap omits entry.path', async () => {
  alerts.length = 0;
  const { mock, requests } = createGitHubMock();
  fetchMock = mock;

  await registeredListeners[0].handler({ entry: newAnnouncementEntry() });

  assert.equal(alerts.length, 0);
  const treeRequest = requests.find(request => request.url.endsWith('/git/trees'));
  const tree = JSON.parse(treeRequest.body).tree;
  assert.deepEqual(tree, [
    {
      path: 'public/images/announcements/test456.png',
      mode: '100644',
      type: 'blob',
      sha: 'source-image-blob',
    },
    {
      path: 'public/images/announcements/sfa.png',
      mode: '100644',
      type: 'blob',
      sha: null,
    },
    {
      path: 'src/data/announcements/test456.md',
      mode: '100644',
      type: 'blob',
      sha: 'entry-blob',
    },
  ]);

  const blobRequest = requests.find(request => request.url.endsWith('/git/blobs'));
  const patchedEntry = Buffer.from(JSON.parse(blobRequest.body).content, 'base64').toString('utf8');
  assert.match(patchedEntry, /coverImage: \/images\/announcements\/test456\.png/);
  assert.doesNotMatch(patchedEntry, /sfa\.png/);

  const refRequest = requests.find(request => request.method === 'PATCH');
  assert.deepEqual(JSON.parse(refRequest.body), { sha: 'new-commit', force: false });
});

test('postSave aborts the whole rename when the target contains a different image', async () => {
  alerts.length = 0;
  const { mock, requests } = createGitHubMock({ targetSha: 'different-image-blob' });
  fetchMock = mock;

  await registeredListeners[0].handler({ entry: newAnnouncementEntry() });

  assert.equal(alerts.length, 1);
  assert.equal(requests.some(request => request.method === 'POST'), false);
  assert.equal(requests.some(request => request.method === 'PATCH'), false);
});

test('postSave aborts when a source image is missing', async () => {
  alerts.length = 0;
  const { mock, requests } = createGitHubMock({ sourceStatus: 404 });
  fetchMock = mock;

  await registeredListeners[0].handler({ entry: newAnnouncementEntry() });

  assert.equal(alerts.length, 1);
  assert.equal(requests.some(request => request.method === 'POST'), false);
});

test('postSave does not hide non-404 GitHub API failures', async () => {
  alerts.length = 0;
  const { mock, requests } = createGitHubMock({ entryStatus: 403 });
  fetchMock = mock;

  await registeredListeners[0].handler({ entry: newAnnouncementEntry() });

  assert.equal(alerts.length, 1);
  assert.equal(requests.some(request => request.method === 'POST'), false);
});

test('registers a postSave listener', () => {
  assert.equal(registeredListeners.length, 1);
  assert.equal(registeredListeners[0].name, 'postSave');
});
