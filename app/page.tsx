'use client';
import { useState, type SyntheticEvent } from 'react';
import { LockKeyhole, ArrowRight, LibraryBig, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import Library, { type Opened } from '@/components/library';
import {
  fingerprint,
  openWithSession,
  unlock,
  validateEnvelope,
} from '@/lib/vault';
import { readDraft } from '@/lib/storage';
import { mergeCatalogues, validateCatalogue } from '@/lib/catalogue';
export default function Home() {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [opened, setOpened] = useState<Opened | null>(null);
  async function submit(e: SyntheticEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      if (!crypto.subtle)
        throw new Error('Open this library over HTTPS in a current browser.');
      const response = await fetch('./library.enc.json', { cache: 'no-store' });
      if (!response.ok)
        throw new Error(
          'The encrypted library could not be loaded. Please retry.',
        );
      const envelope = validateEnvelope(await response.json());
      let result;
      try {
        result = await unlock(envelope, password);
      } catch {
        throw new Error(
          'That password did not unlock the library. Check it and try again.',
        );
      }
      const sharedCatalogue = validateCatalogue(result.value);
      let catalogue = sharedCatalogue;
      const baseline = await fingerprint(envelope);
      let dirty = false;
      let notice = '';
      try {
        const draft = await readDraft();
        if (draft?.dirty) {
          try {
            const draftCatalogue = validateCatalogue(
              await openWithSession(draft.envelope, result.session),
            );
            catalogue = mergeCatalogues(
              sharedCatalogue,
              draftCatalogue,
            ).catalogue;
            notice =
              draft.baseline !== baseline
                ? 'Your encrypted browser draft was merged with the latest shared library.'
                : 'Your unpublished changes were restored from this browser.';
            dirty = true;
          } catch {
            notice =
              'An older browser draft could not be unlocked. The shared library is open; the older draft is unchanged.';
          }
        }
      } catch {
        notice =
          'Browser storage is unavailable. Export encrypted backups to keep edits.';
      }
      setPassword('');
      setOpened({
        catalogue,
        session: result.session,
        baseline,
        dirty,
        notice,
      });
    } catch (e) {
      setError(
        e instanceof Error ? e.message : 'Could not unlock the library.',
      );
    } finally {
      setBusy(false);
    }
  }
  if (opened)
    return (
      <Library
        initial={opened}
        lock={() => {
          setOpened(null);
          setPassword('');
        }}
      />
    );
  return (
    <main className="unlock-page">
      <div className="unlock-brand">
        <LibraryBig size={28} />
        <span>Dental Library</span>
      </div>
      <section className="unlock-card">
        <span className="eyebrow">YOUR PERSONAL LEARNING LIBRARY</span>
        <div className="lock-symbol">
          <LockKeyhole size={30} />
        </div>
        <h1>
          A place for everything
          <br />
          you’re learning.
        </h1>
        <p>
          Your lectures, disciplines and ideas.
          <br />
          Enter your library password to open the collection.
        </p>
        <form onSubmit={submit}>
          <label htmlFor="password">Library password</label>
          <Input
            id="password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
            disabled={busy}
          />
          {error && (
            <div role="alert" className="error">
              {error}
            </div>
          )}
          <Button
            className="primary-btn"
            type="submit"
            disabled={busy || !password}
          >
            {busy ? 'Unlocking…' : 'Unlock library'} <ArrowRight size={18} />
          </Button>
        </form>
        <div className="privacy-line">
          <ShieldCheck size={16} /> Encrypted before it reaches GitHub
        </div>
      </section>
      <footer>CPD · LECTURE NOTES · TEXTBOOKS</footer>
    </main>
  );
}
