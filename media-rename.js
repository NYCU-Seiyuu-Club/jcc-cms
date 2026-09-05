(function () {
  const REPO = 'NYCU-Seiyuu-Club/nycu-jcc-website';
  const BRANCH = 'main';
  const API_ROOT = 'https://api.github.com';
  const IMAGES_PREFIX = '/images/announcements/';
  const SLUG_PATTERN = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/;
  const COLLECTION_FOLDERS = {
    announcements: 'src/data/announcements',
    journals: 'src/data/journals',
  };

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

  function resolveEntryPath(entry, slug) {
    const existingPath = entry.get('path');
    if (typeof existingPath === 'string' && existingPath) {
      return existingPath.replace(/\\/g, '/');
    }

    const folder = COLLECTION_FOLDERS[entry.get('collection')];
    return folder && SLUG_PATTERN.test(slug || '') ? `${folder}/${slug}.md` : null;
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

  // atob/btoa are Latin1-only; the markdown files here contain Chinese text,
  // so round-tripping through GitHub's base64 content needs real UTF-8 codecs.
  function base64ToUtf8(base64) {
    const binary = atob(base64.replace(/\n/g, ''));
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return new TextDecoder('utf-8').decode(bytes);
  }

  function utf8ToBase64(text) {
    const bytes = new TextEncoder().encode(text);
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
  }

  class GitHubRequestError extends Error {
    constructor(status, path, responseText) {
      super(`GitHub API ${status} ${path}: ${responseText}`);
      this.name = 'GitHubRequestError';
      this.status = status;
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
      const responseText = await response.text().catch(() => '');
      throw new GitHubRequestError(response.status, path, responseText);
    }
    return response.status === 204 ? null : response.json();
  }

  async function githubRequestOrNull(path, options, token) {
    try {
      return await githubRequest(path, options, token);
    } catch (error) {
      if (error && error.status === 404) return null;
      throw error;
    }
  }

  // Renames every managed image and rewrites the entry's own markdown file to
  // match, all as one follow-up commit. Runs from postSave (after Decap has
  // already committed the entry + any freshly-picked images together), because
  // images added via the inline field control are NOT committed separately at
  // upload time — they ride along in the same commit as the entry save, so a
  // preSave-time GitHub API lookup for them 404s and finds nothing to rename.
  async function applyRenamesAndPatchEntry({ entryPath, renames }) {
    if (renames.length === 0) return;
    const token = getToken();
    if (!token) throw new Error('找不到 CMS 登入權杖，無法重新命名圖片。');

    const ref = await githubRequest(`/repos/${REPO}/git/ref/heads/${BRANCH}`, { method: 'GET' }, token);
    const baseCommitSha = ref.object.sha;
    const baseCommit = await githubRequest(`/repos/${REPO}/git/commits/${baseCommitSha}`, { method: 'GET' }, token);
    const baseTreeSha = baseCommit.tree.sha;

    const moves = renames.filter(({ from, to }) => from !== to);
    if (moves.length === 0) return;

    const entryRepoPath = entryPath;
    const entryFile = await githubRequest(
      `/repos/${REPO}/contents/${encodeGitPath(entryRepoPath)}?ref=${BRANCH}`,
      { method: 'GET' },
      token,
    );
    let entryText = base64ToUtf8(entryFile.content);
    const missingReference = moves.find(({ from }) => !entryText.includes(from));
    if (missingReference) {
      throw new Error(`文章內容找不到待改名圖片：${missingReference.from}`);
    }

    const preparedMoves = [];
    for (const { from, to } of moves) {
      const oldRepoPath = toRepoPath(from);
      const newRepoPath = toRepoPath(to);

      const oldFile = await githubRequestOrNull(
        `/repos/${REPO}/contents/${encodeGitPath(oldRepoPath)}?ref=${BRANCH}`,
        { method: 'GET' },
        token,
      );
      if (!oldFile || !oldFile.sha) {
        throw new Error(`找不到待改名圖片：${oldRepoPath}`);
      }

      const existingTarget = await githubRequestOrNull(
        `/repos/${REPO}/contents/${encodeGitPath(newRepoPath)}?ref=${BRANCH}`,
        { method: 'GET' },
        token,
      );
      if (existingTarget && existingTarget.sha !== oldFile.sha) {
        throw new Error(`目標檔名已被其他圖片使用：${newRepoPath}`);
      }

      preparedMoves.push({ from, to, oldRepoPath, newRepoPath, sha: oldFile.sha });
    }

    const treeEntries = [];
    for (const move of preparedMoves) {
      treeEntries.push({ path: move.newRepoPath, mode: '100644', type: 'blob', sha: move.sha });
      treeEntries.push({ path: move.oldRepoPath, mode: '100644', type: 'blob', sha: null });
      entryText = entryText.split(move.from).join(move.to);
    }

    const entryBlob = await githubRequest(
      `/repos/${REPO}/git/blobs`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: utf8ToBase64(entryText), encoding: 'base64' }),
      },
      token,
    );
    treeEntries.push({ path: entryRepoPath, mode: '100644', type: 'blob', sha: entryBlob.sha });

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
        body: JSON.stringify({ sha: newCommit.sha, force: false }),
      },
      token,
    );
  }

  CMS.registerEventListener({
    name: 'postSave',
    handler: async ({ entry }) => {
      const data = entry.get('data');
      const slug = data.get('slug');
      const coverImage = data.get('coverImage');
      const body = data.get('body');

      const { renames } = planRenames({ slug, coverImage, body });
      if (renames.length === 0) return;

      try {
        const entryPath = resolveEntryPath(entry, slug);
        if (!entryPath) throw new Error('無法判斷文章在儲存庫中的路徑。');
        await applyRenamesAndPatchEntry({ entryPath, renames });
      } catch (error) {
        console.error('[media-rename] 圖片重新命名失敗，圖片檔名維持原樣：', error);
        window.alert('圖片依 slug 重新命名失敗（內文已正常儲存，圖片檔名維持原樣）。詳情請見瀏覽器主控台。');
      }
    },
  });

  window.JCCMediaRename = { planRenames, resolveEntryPath };
})();
