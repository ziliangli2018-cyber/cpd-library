'use client';

import { useEffect, useState } from 'react';
import {
  BookOpenCheck,
  Circle,
  Clock3,
  ExternalLink,
  FileVideo,
  LockKeyhole,
  NotebookPen,
  Pencil,
  Play,
  Save,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import {
  youtubeVideoId,
  type Lecture,
  type LectureProgressStatus,
} from '@/lib/catalogue';
import { duration } from '@/components/lecture-editor';

function visibilityText(lecture: Lecture) {
  if (lecture.youtubeStatus === 'unavailable') return 'Unavailable on YouTube';
  if (lecture.youtubePrivacy === 'private') return 'Private · open on YouTube';
  if (lecture.youtubePrivacy === 'unlisted') return 'Unlisted · shareable';
  if (lecture.youtubePrivacy === 'public') return 'Public';
  return 'Visibility not checked';
}

export function LecturePage({
  lecture,
  busy,
  onEdit,
  onWatch,
  onProgress,
  onSaveNotes,
}: {
  lecture: Lecture;
  busy: boolean;
  onEdit: (lecture: Lecture) => void;
  onWatch: (lecture: Lecture) => void;
  onProgress: (lecture: Lecture, status: LectureProgressStatus) => void;
  onSaveNotes: (lectureId: string, notes: string) => Promise<void>;
}) {
  const [playerLoaded, setPlayerLoaded] = useState(false);
  const [notes, setNotes] = useState(lecture.notes);
  const [notesStatus, setNotesStatus] = useState('');
  const videoId = youtubeVideoId(lecture.youtubeUrl);
  const canEmbed =
    !!videoId &&
    lecture.youtubeStatus !== 'unavailable' &&
    lecture.youtubePrivacy !== 'private';

  useEffect(() => {
    setPlayerLoaded(false);
    setNotes(lecture.notes);
    setNotesStatus('');
  }, [lecture.id, lecture.notes]);

  async function saveNotes() {
    setNotesStatus('Saving encrypted notes…');
    try {
      await onSaveNotes(lecture.id, notes);
      setNotesStatus('Notes saved in your encrypted draft');
    } catch {
      setNotesStatus('Notes could not be saved');
    }
  }

  return (
    <section className="lecture-page" aria-label={`${lecture.title} lecture`}>
      <div className="lecture-page-grid">
        <div className="lecture-player-card">
          <div className="lecture-player-shell">
            {canEmbed && playerLoaded ? (
              <iframe
                src={`https://www.youtube-nocookie.com/embed/${videoId}?autoplay=1&rel=0`}
                title={`YouTube video: ${lecture.youtubeTitle || lecture.title}`}
                allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
                allowFullScreen
              />
            ) : canEmbed ? (
              <button
                className="lecture-player-start"
                disabled={busy}
                onClick={() => {
                  setPlayerLoaded(true);
                  onWatch(lecture);
                }}
              >
                <span><Play size={28} fill="currentColor" /></span>
                <strong>Play video</strong>
                <small>The embedded player loads when you press play.</small>
              </button>
            ) : (
              <div className="lecture-player-fallback">
                {lecture.youtubePrivacy === 'private' ? (
                  <LockKeyhole size={34} />
                ) : (
                  <FileVideo size={34} />
                )}
                <strong>
                  {lecture.youtubeUrl
                    ? visibilityText(lecture)
                    : 'No YouTube video linked yet'}
                </strong>
                <p>
                  {lecture.youtubePrivacy === 'private'
                    ? 'Private videos cannot play in an embedded player. Open YouTube while signed in to the owner or an invited account.'
                    : lecture.youtubeUrl
                      ? 'Refresh the YouTube details or open the video directly.'
                      : 'Add the matching YouTube link to embed this lecture here.'}
                </p>
              </div>
            )}
          </div>

          <div className="lecture-video-actions">
            <label className={`progress-select ${lecture.progressStatus}`}>
              <span className="progress-select-icon" aria-hidden="true">
                {lecture.progressStatus === 'seen' ? (
                  <BookOpenCheck size={15} />
                ) : lecture.progressStatus === 'in-progress' ? (
                  <Clock3 size={15} />
                ) : (
                  <Circle size={13} />
                )}
              </span>
              <span className="sr-only">Learning status for {lecture.title}</span>
              <select
                aria-label={`Learning status for ${lecture.title}`}
                value={lecture.progressStatus}
                disabled={busy}
                onChange={(event) =>
                  onProgress(
                    lecture,
                    event.target.value as LectureProgressStatus,
                  )
                }
              >
                <option value="unseen">Unseen</option>
                <option value="in-progress">In progress</option>
                <option value="seen">Seen</option>
              </select>
            </label>
            {lecture.youtubeUrl ? (
              <a
                className="lecture-youtube-link"
                href={lecture.youtubeUrl}
                target="_blank"
                rel="noopener noreferrer"
                onClick={() => onWatch(lecture)}
              >
                Open on YouTube <ExternalLink size={14} />
              </a>
            ) : (
              <Button variant="outline" onClick={() => onEdit(lecture)}>
                Add YouTube link
              </Button>
            )}
          </div>
        </div>

        <aside className="lecture-details-card">
          <div className="lecture-detail-heading">
            <span className="eyebrow">LECTURE DETAILS</span>
            <Button variant="outline" size="sm" onClick={() => onEdit(lecture)}>
              <Pencil size={14} /> Edit details
            </Button>
          </div>
          <dl>
            <div>
              <dt>Course</dt>
              <dd>{lecture.course || 'Uncategorised course'}</dd>
            </div>
            {lecture.module && (
              <div>
                <dt>Module</dt>
                <dd>{lecture.module}</dd>
              </div>
            )}
            <div>
              <dt>Duration</dt>
              <dd>{duration(lecture.duration)}</dd>
            </div>
            <div>
              <dt>YouTube</dt>
              <dd className={`youtube-privacy ${lecture.youtubePrivacy || 'unknown'}`}>
                {visibilityText(lecture)}
              </dd>
            </div>
            {lecture.youtubeTitle && lecture.youtubeTitle !== lecture.title && (
              <div>
                <dt>YouTube title</dt>
                <dd>{lecture.youtubeTitle}</dd>
              </div>
            )}
            <div>
              <dt>Source file</dt>
              <dd>{lecture.source} · {lecture.relativePath || 'Manually added'}</dd>
            </div>
          </dl>
          {!!lecture.tags.length && (
            <div className="lecture-page-tags">
              {lecture.tags.map((tag) => <span key={tag}>#{tag}</span>)}
            </div>
          )}
        </aside>
      </div>

      <section className="lecture-notes-card" aria-labelledby="lecture-notes-heading">
        <div className="lecture-notes-heading">
          <div>
            <span className="eyebrow">YOUR NOTES</span>
            <h2 id="lecture-notes-heading"><NotebookPen size={20} /> Lecture notes</h2>
          </div>
          <span>{notesStatus}</span>
        </div>
        <Textarea
          value={notes}
          onChange={(event) => {
            setNotes(event.target.value);
            setNotesStatus(
              event.target.value === lecture.notes ? '' : 'Unsaved changes',
            );
          }}
          placeholder="Write your notes, clinical takeaways, questions, or timestamps…"
          rows={10}
          disabled={busy}
        />
        <div className="lecture-notes-actions">
          <small>Notes are encrypted with the rest of your library.</small>
          <Button
            className="primary-btn"
            disabled={busy || notes === lecture.notes}
            onClick={() => void saveNotes()}
          >
            <Save size={16} /> Save notes
          </Button>
        </div>
      </section>
    </section>
  );
}
