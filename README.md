# Dental Library

A static, password-encrypted dental CPD catalogue designed for GitHub Pages. Videos remain in their source folders and on YouTube. This project does not upload media.

## Use the library

1. Open the site and enter the library password. The initial password is stored **only on the owner's computer** in `.private/library-password.txt`.
2. The Home page groups the library by discipline and shows recently watched videos. Open a discipline to see its courses, then open a course to see its videos. Courses with several modules use collapsible module sections; courses without meaningful module divisions show one direct video list.
3. Mark each video **Unseen**, **In progress** or **Seen**. Opening a video records it in watch history and moves an unseen video to in progress; opening a completed video leaves it seen.
4. Search titles, courses, disciplines and tags. Combine search with discipline, course, source and YouTube-link filters when you need to find an individual video directly.
5. Open a lecture to edit its title, main discipline, comma-separated tags, YouTube URL and notes. Notes also appear in their own section.
6. **Save lecture** and progress changes are stored in an encrypted draft in that browser. **Library settings → Publish changes** saves the encrypted catalogue, including video statuses and watch history, to GitHub for other devices and readers.
7. Use **Export backup** regularly. Backups include progress and history, are encrypted and require the same password. Import merges records by ID and keeps the more recently edited record.
8. The textbook section is reserved for a later expansion. Source PDFs and other documents have been counted but have not been imported or uploaded.

## Sharing and privacy

The site code and encrypted data file are public; the catalogue, source filenames, tags, notes, YouTube links, viewing status and watch history are encrypted. Share the site address and password separately. Anyone with the password can read the entire catalogue. Publishing changes additionally requires write access to the GitHub repository.

The browser uses AES-256-GCM with a fresh random 96-bit IV per encryption and PBKDF2-SHA256 with 600,000 iterations and a 128-bit random salt. The password-derived key remains in memory; browser drafts are encrypted in IndexedDB. The Lock button removes the unlocked application state. No analytics, third-party fonts, video thumbnails or YouTube players load with the catalogue.

GitHub publishing uses a fine-grained token restricted to this repository with **Contents: read and write**. The token stays in memory while the settings panel is open; it is never written to the repository or browser storage. Saves verify the catalogue revision originally opened. A conflict preserves the local draft; export it, then use **Load & merge latest** and review before publishing. Lecture content uses the newer record when both copies were edited, while progress and watch history merge independently so a routine viewing update cannot replace newer notes, tags or links.

This is shared-password access, not individual accounts or revocable invitations. Someone who already downloaded a decrypted catalogue can retain it. An old password can still unlock historical encrypted versions saved under that password. Encryption protects stored catalogue contents, not an unlocked session running modified site code. Keep repository write access limited. YouTube's own visibility settings govern who can watch each video.

## Run locally

Requires Node 24 or newer and Python 3 for source scans.

```powershell
npm ci
npm run dev -- --port 5173
```

Open `http://127.0.0.1:5173/`. The site works from localhost or HTTPS because it uses Web Crypto.

## Add newly downloaded source files

The owner's source configuration is `.private/sources.json`, containing a `sources` array of objects with `name` and `path`. This local file is ignored by Git. The scanner reads directory metadata and allowlisted fields from a Dent-S manifest; it never opens video content or downloads OneDrive placeholders.

**First export your latest browser/shared library and restore it locally**, so the rescan starts with current tags, links and notes:

```powershell
node scripts/restore-backup.mjs "PATH_TO_LATEST_ENCRYPTED_BACKUP"
npm run scan
npm run refresh-youtube
npm run link-youtube
npm run encrypt
```

The scan tracks source metadata separately from human edits, preserves edited fields and stable IDs, adds new source files and flags missing sources without deleting records. It retains descriptively titled `.ts` recordings and flags possible same-name/size duplicates without merging them. Files modified in the last three minutes, zero-byte files and known undersized downloads are skipped. File presence does not verify playback or completeness when expected size is unknown. The YouTube refresh reads the authenticated channel's current uploads through the official API. Linking then uses the uploader's exact source path and only accepts IDs still present on that channel; manually edited links win.

## Make linked private videos shareable

YouTube private videos cannot play for library readers unless their Google accounts were invited. The visibility helper can change catalogue-linked private videos on the configured channel to **unlisted**, allowing anyone with a library link to play them while keeping them out of normal public channel listings and search.

Start with the read-only audit. It verifies that OAuth is authorised for the configured channel and fetches every linked video's current owner and status directly from YouTube in batches:

```powershell
npm run youtube:unlisted
```

The JSON summary reports `ownedPrivateEligible`, the default 100-video `plannedThisRun` batch, and all skipped categories. Details are saved locally in `.private/youtube-unlisted-report.json`. Scheduled private videos and videos with an unfamiliar status field are blocked rather than changed.

Only after reviewing a fresh audit, apply that exact batch by passing its `plannedThisRun` value. For example, if it reports 100:

```powershell
npm run youtube:unlisted -- --apply --confirm-count 100
```

Apply mode preserves the video's returned mutable status settings, changes only `privacyStatus`, and records progress after every request. It stops before writing if the live planned count differs from `--confirm-count`. Rerun the audit before each subsequent batch; already-unlisted videos are automatically skipped, so interrupted and quota-limited runs resume safely. Use `--max-updates N` in both commands to choose a smaller cap.

`npm run encrypt` updates `public/library.enc.json` using the existing password and salt with a fresh IV. It does not publish. Import that file into the site to merge it with your browser draft, then publish through Library settings. Do not overwrite the shared catalogue from an outdated local scan.

## Publish on GitHub Pages

1. Create a dedicated public repository named `cpd-library` in the owner's GitHub account. Only application source and **encrypted** data belong in it; never add `.private` or any original media.
2. Push this project's source to its `main` branch.
3. In repository **Settings → Pages → Build and deployment**, select **GitHub Actions**.
4. Run the included **Publish encrypted dental library** workflow. It tests, type-checks, builds a static export with portable relative asset paths and deploys only `dist/client`.
5. Use the URL reported by the successful deployment. GitHub saves from the site's settings panel trigger the same deployment automatically.

The workflow uses GitHub's [official custom Pages workflow](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages) pattern. If the repository name or owner changes, enter the new values in Library settings when publishing.

## Validation

```powershell
npm test
npm run build
```

Tests cover Unicode encryption round trips, wrong passwords, tampering, fresh IVs, invalid envelopes, tag search, video progress and watch-history behaviour, YouTube URL validation, stale concurrent edits, expired GitHub tokens and ambiguous network responses. The production build includes TypeScript checks and a guard against private files, the local password and unexpected source maps in public output. Only app-owned files are included in the `lint` script; the generated component catalogue remains unmodified.
