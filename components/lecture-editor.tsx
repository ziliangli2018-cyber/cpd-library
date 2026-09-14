import { useState, type SyntheticEvent } from 'react';
import { Check, LockKeyhole } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Choice } from '@/components/choice';
import {
  DISCIPLINES,
  normalizeTags,
  youtubeUrl,
  type Lecture,
} from '@/lib/catalogue';
export function duration(s: number | null) {
  if (s === null) return 'Duration not recorded';
  const m = Math.round(s / 60);
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m} min`;
}
export function LectureEditor({
  lecture,
  busy,
  onSave,
}: {
  lecture: Lecture;
  busy: boolean;
  onSave: (v: Lecture) => Promise<void>;
}) {
  const [draft, setDraft] = useState({ ...lecture });
  const [tags, setTags] = useState(lecture.tags.join(', '));
  const [error, setError] = useState('');
  async function submit(e: SyntheticEvent) {
    e.preventDefault();
    setError('');
    try {
      const title = draft.title.trim();
      if (!title) throw new Error('Add a lecture title.');
      const nextYoutubeUrl = youtubeUrl(draft.youtubeUrl);
      const youtubeChanged = nextYoutubeUrl !== lecture.youtubeUrl;
      const taxonomyChanged =
        draft.course.trim() !== lecture.course ||
        draft.module.trim() !== lecture.module ||
        draft.discipline !== lecture.discipline;
      const now = new Date().toISOString();
      const next: Lecture = {
        ...draft,
        title,
        course: draft.course.trim() || 'Independent lectures',
        module: draft.module.trim(),
        tags: normalizeTags(tags),
        youtubeUrl: nextYoutubeUrl,
        youtubeSource: youtubeChanged ? 'manual' : draft.youtubeSource,
        youtubePrivacy: youtubeChanged ? undefined : draft.youtubePrivacy,
        youtubeTitle: youtubeChanged ? undefined : draft.youtubeTitle,
        youtubeStatus: youtubeChanged ? undefined : draft.youtubeStatus,
        youtubePreviousUrl: youtubeChanged
          ? undefined
          : draft.youtubePreviousUrl,
        youtubeUnavailableAt: youtubeChanged
          ? undefined
          : draft.youtubeUnavailableAt,
        youtubeUpdatedAt: youtubeChanged
          ? now
          : draft.youtubeUpdatedAt,
        taxonomySource: taxonomyChanged ? 'manual' : draft.taxonomySource,
        taxonomyUpdatedAt: taxonomyChanged ? now : draft.taxonomyUpdatedAt,
        classificationReviewed: taxonomyChanged
          ? true
          : draft.classificationReviewed,
        updatedAt: now,
      };
      await onSave(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save.');
    }
  }
  return (
    <>
      <DialogTitle>
        {lecture.title ? 'Lecture details' : 'Add a lecture'}
      </DialogTitle>
      <DialogDescription>
        Update the YouTube link, organise tags, or capture your notes.
      </DialogDescription>
      <form className="lecture-form" onSubmit={submit}>
        <label htmlFor="lecture-title">Lecture title</label>
        <Input
          id="lecture-title"
          value={draft.title}
          onChange={(e) => setDraft({ ...draft, title: e.target.value })}
          required
        />
        <div className="form-grid">
          <div>
            <label htmlFor="lecture-course">Course</label>
            <Input
              id="lecture-course"
              value={draft.course}
              onChange={(e) => setDraft({ ...draft, course: e.target.value })}
            />
          </div>
          <div>
            <label htmlFor="lecture-module">Module</label>
            <Input
              id="lecture-module"
              value={draft.module}
              onChange={(e) => setDraft({ ...draft, module: e.target.value })}
            />
          </div>
        </div>
        <label htmlFor="main-discipline">Main discipline</label>
        <Choice
          id="main-discipline"
          label="Main discipline"
          value={draft.discipline}
          onChange={(v) => setDraft({ ...draft, discipline: v })}
          options={DISCIPLINES.map((d) => ({ value: d, label: d }))}
        />
        {!lecture.classificationReviewed && (
          <p className="field-help">
            Organised from the source folder hierarchy. Changing the course or
            discipline applies that correction to the whole course.
          </p>
        )}
        <label htmlFor="lecture-tags">Tags</label>
        <Input
          id="lecture-tags"
          value={tags}
          onChange={(e) => setTags(e.target.value)}
          placeholder="e.g. Clear aligners, Treatment planning"
        />
        <p className="field-help">
          Separate tags with commas. Every tag is searchable.
        </p>
        <label htmlFor="youtube-link">YouTube video link</label>
        <Input
          id="youtube-link"
          type="url"
          value={draft.youtubeUrl}
          onChange={(e) => setDraft({ ...draft, youtubeUrl: e.target.value })}
          placeholder="https://www.youtube.com/watch?v=…"
        />
        <p className="field-help">
          Leave blank until uploaded. Replace the link whenever needed.
        </p>
        {draft.youtubeUrl === lecture.youtubeUrl &&
          draft.youtubePrivacy === 'private' && (
            <p className="youtube-private-warning" role="note">
              <LockKeyhole size={14} /> Private on YouTube: only the owner and
              accounts invited in YouTube can watch this video.
            </p>
          )}
        <label htmlFor="lecture-notes">Lecture notes</label>
        <Textarea
          id="lecture-notes"
          value={draft.notes}
          onChange={(e) => setDraft({ ...draft, notes: e.target.value })}
          rows={5}
          placeholder="Key ideas, observations and questions to revisit…"
        />
        {lecture.relativePath && (
          <details className="source-details">
            <summary>Source file details</summary>
            <dl>
              <dt>Collection</dt>
              <dd>{lecture.source}</dd>
              <dt>Relative location</dt>
              <dd>{lecture.relativePath}</dd>
              <dt>Duration</dt>
              <dd>{duration(lecture.duration)}</dd>
              <dt>File status</dt>
              <dd>{lecture.availability} · Playback not checked</dd>
              {lecture.duplicateGroup && (
                <>
                  <dt>Possible duplicate</dt>
                  <dd>
                    Another file has the same name and size. Both records have
                    been kept.
                  </dd>
                </>
              )}
            </dl>
          </details>
        )}
        {error && (
          <div className="error" role="alert">
            {error}
          </div>
        )}
        <div className="editor-footer">
          <span>
            <LockKeyhole size={13} /> Saves an encrypted browser draft
          </span>
          <Button type="submit" className="primary-btn" disabled={busy}>
            <Check size={16} />
            {busy ? 'Saving…' : 'Save lecture'}
          </Button>
        </div>
      </form>
    </>
  );
}
