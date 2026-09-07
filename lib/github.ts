import { fingerprint, validateEnvelope, type Envelope } from './vault.ts';
export type GithubConfig = { repo: string; branch: string; token: string };
function headers(c: GithubConfig) {
  return {
    Authorization: `Bearer ${c.token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}
function endpoint(c: GithubConfig) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(c.repo) || !c.branch.trim() || !c.token.trim())
    throw new Error(
      'Enter owner/repository, branch and a GitHub access token.',
    );
  return `https://api.github.com/repos/${c.repo}/contents/public/library.enc.json`;
}
async function checked(r: Response): Promise<Response> {
  if (!r.ok)
    throw new Error(
      r.status === 409 || r.status === 422
        ? 'The shared library changed. Your draft is safe. Export it before loading the latest version.'
        : `GitHub could not complete the request (${r.status}). Check the repository and token permissions. Your draft is safe.`,
    );
  return r;
}
export async function readGithub(
  c: GithubConfig,
): Promise<{ sha: string; envelope: Envelope }> {
  const url = endpoint(c) + `?ref=${encodeURIComponent(c.branch)}`;
  const meta = (await (
    await checked(await fetch(url, { headers: headers(c), cache: 'no-store' }))
  ).json()) as { sha?: string };
  if (!meta.sha)
    throw new Error(
      'GitHub did not return a file revision. No changes were sent.',
    );
  const raw = await checked(
    await fetch(url, {
      headers: { ...headers(c), Accept: 'application/vnd.github.raw+json' },
      cache: 'no-store',
    }),
  );
  return { sha: meta.sha, envelope: validateEnvelope(await raw.json()) };
}
export async function pushGithub(
  c: GithubConfig,
  envelope: Envelope,
  baseline: string,
): Promise<void> {
  const current = await readGithub(c);
  if ((await fingerprint(current.envelope)) !== baseline)
    throw new Error(
      'The shared library has changed since you opened it. Your draft is safe. Export your backup before loading the latest version.',
    );
  const text = JSON.stringify(envelope);
  const content = btoa(text);
  try {
    await checked(
      await fetch(endpoint(c), {
        method: 'PUT',
        headers: { ...headers(c), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: 'Update encrypted CPD library',
          content,
          sha: current.sha,
          branch: c.branch,
        }),
      }),
    );
  } catch (error) {
    // A timeout after GitHub accepted the commit must not cause a duplicate write.
    try {
      const after = await readGithub(c);
      if ((await fingerprint(after.envelope)) === (await fingerprint(envelope)))
        return;
    } catch {}
    throw error;
  }
}
