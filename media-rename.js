(function () {
  const REPO = 'NYCU-Seiyuu-Club/nycu-jcc-website';
  const BRANCH = 'main';
  const API_ROOT = 'https://api.github.com';
  const IMAGES_PREFIX = '/images/announcements/';
  const SLUG_PATTERN = /^[a-z0-9-]+$/;

  function isManagedPath(path) {
    return typeof path === 'string' && path.startsWith(IMAGES_PREFIX);
  }

  function extOf(path) {
    const match = /\.[a-z0-9]+$/i.exec(path);
    return match ? match[0].toLowerCase() : '.jpg';
  }

  function buildCorrectPattern(slug) {
    const prefix = IMAGES_PREFIX.replace(/\//g, '\\/');
    return new RegExp(`^${prefix}${slug}(?:-([2-9]|[1-9]\\d+))?(\\.[a-z0-9]+)$`, 'i');
  }

  function findBodyImagePaths(body) {
    if (!body) return [];
    const prefix = IMAGES_PREFIX.replace(/\//g, '\\/');
    const pattern = new RegExp(`${prefix}[A-Za-z0-9._%-]+`, 'g');
    return [...body.matchAll(pattern)].map((match) => match[0]);
  }

  // Pure planning: given the live slug/coverImage/body, decide which managed
  // images no longer match "slug.ext" / "slug-2.ext" naming and need renaming,
  // without touching anything already correctly named (idempotent on repeat saves).
  function planRenames({ slug, coverImage, body }) {
    const noop = { renames: [], nextCoverImage: coverImage, nextBody: body || '' };
    if (!SLUG_PATTERN.test(slug || '')) return noop;

    const correctPattern = buildCorrectPattern(slug);
    const renames = new Map(); // oldPath -> newPath
    const reserved = new Set();

    const bodyPaths = findBodyImagePaths(body);
    const candidates = [];
    if (isManagedPath(coverImage)) candidates.push(coverImage);
    for (const path of bodyPaths) if (isManagedPath(path)) candidates.push(path);

    for (const path of candidates) {
      const match = correctPattern.exec(path);
      if (match && match[1]) reserved.add(Number(match[1]));
    }

    function nextNumber() {
      let n = 2;
      while (reserved.has(n)) n++;
      reserved.add(n);
      return n;
    }

    let nextCoverImage = coverImage;
    if (isManagedPath(coverImage) && !correctPattern.test(coverImage)) {
      const newPath = `${IMAGES_PREFIX}${slug}${extOf(coverImage)}`;
      renames.set(coverImage, newPath);
      nextCoverImage = newPath;
    }

    const seen = new Set();
    for (const path of bodyPaths) {
      if (!isManagedPath(path) || seen.has(path)) continue;
      seen.add(path);
      if (renames.has(path) || correctPattern.test(path)) continue;
      const newPath = `${IMAGES_PREFIX}${slug}-${nextNumber()}${extOf(path)}`;
      renames.set(path, newPath);
    }

    let nextBody = body || '';
    for (const [oldPath, newPath] of renames) {
      nextBody = nextBody.split(oldPath).join(newPath);
    }

    return {
      renames: [...renames.entries()].map(([from, to]) => ({ from, to })),
      nextCoverImage,
      nextBody,
    };
  }

  function toRepoPath(publicPath) {
    return `public${publicPath}`;
  }

  function encodeGitPath(repoPath) {
    return repoPath.split('/').map(encodeURIComponent).join('/');
  }

  function getToken() {
    try {
      const raw = window.localStorage.getItem('decap-cms-user');
      const parsed = raw ? JSON.parse(raw) : null;
      return parsed && parsed.token ? parsed.token : null;
    } catch (error) {
      return null;
    }
  }

  async function githubRequest(path, options, token) {
    const response = await fetch(`${API_ROOT}${path}`, {
      ...options,
      headers: {
        Authorization: `token ${token}`,
        Accept: 'application/vnd.github+json',
        ...(options && options.headers),
      },
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`GitHub API ${response.status} ${path}: ${text}`);
    }
    return response.status === 204 ? null : response.json();
  }

  // Renames every managed image to its planned path in a single extra commit
  // (one tree update covering all renames), instead of one commit per file.
  async function applyRenames(renames) {
    if (renames.length === 0) return;
    const token = getToken();
    if (!token) throw new Error('找不到 CMS 登入權杖，無法重新命名圖片。');

    const ref = await githubRequest(`/repos/${REPO}/git/ref/heads/${BRANCH}`, { method: 'GET' }, token);
    const baseCommitSha = ref.object.sha;
    const baseCommit = await githubRequest(`/repos/${REPO}/git/commits/${baseCommitSha}`, { method: 'GET' }, token);
    const baseTreeSha = baseCommit.tree.sha;

    const treeEntries = [];
    for (const { from, to } of renames) {
      if (from === to) continue;
      const oldRepoPath = toRepoPath(from);
      const newRepoPath = toRepoPath(to);

      const oldFile = await githubRequest(
        `/repos/${REPO}/contents/${encodeGitPath(oldRepoPath)}?ref=${BRANCH}`,
        { method: 'GET' },
        token,
      ).catch(() => null);
      if (!oldFile || !oldFile.sha) continue; // already gone or not tracked in git — nothing to rename

      const existingTarget = await githubRequest(
        `/repos/${REPO}/contents/${encodeGitPath(newRepoPath)}?ref=${BRANCH}`,
        { method: 'GET' },
        token,
      ).catch(() => null);
      if (existingTarget && existingTarget.sha !== oldFile.sha) {
        console.warn(`[media-rename] 跳過改名，目標檔案已存在且內容不同: ${newRepoPath}`);
        continue;
      }

      treeEntries.push({ path: newRepoPath, mode: '100644', type: 'blob', sha: oldFile.sha });
      treeEntries.push({ path: oldRepoPath, mode: '100644', type: 'blob', sha: null });
    }

    if (treeEntries.length === 0) return;

    const newTree = await githubRequest(
      `/repos/${REPO}/git/trees`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ base_tree: baseTreeSha, tree: treeEntries }),
      },
      token,
    );

    const newCommit = await githubRequest(
      `/repos/${REPO}/git/commits`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: 'CMS: 依 slug 重新命名圖片',
          tree: newTree.sha,
          parents: [baseCommitSha],
        }),
      },
      token,
    );

    await githubRequest(
      `/repos/${REPO}/git/refs/heads/${BRANCH}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sha: newCommit.sha }),
      },
      token,
    );
  }

  CMS.registerEventListener({
    name: 'preSave',
    handler: async ({ entry }) => {
      const data = entry.get('data');
      const slug = data.get('slug');
      const coverImage = data.get('coverImage');
      const body = data.get('body');

      const { renames, nextCoverImage, nextBody } = planRenames({ slug, coverImage, body });
      if (renames.length === 0) return data;

      try {
        await applyRenames(renames);
      } catch (error) {
        console.error('[media-rename] 圖片重新命名失敗，將以原始檔名儲存內容：', error);
        window.alert('圖片依 slug 重新命名失敗（內文仍會正常儲存，圖片檔名維持原樣）。詳情請見瀏覽器主控台。');
        return data;
      }

      let nextData = data;
      if (nextCoverImage !== coverImage) nextData = nextData.set('coverImage', nextCoverImage);
      if (nextBody !== body) nextData = nextData.set('body', nextBody);
      return nextData;
    },
  });

  window.JCCMediaRename = { planRenames };
})();
