'use client';

import type { CSSProperties } from 'react';

import {
  BookOpenCheck,
  ChevronRight,
  Circle,
  Clock3,
  ExternalLink,
  FolderOpen,
  Layers3,
  LockKeyhole,
  NotebookPen,
  Play,
  RotateCcw,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { duration } from '@/components/lecture-editor';
import {
  courseLabel,
  lastWatchedAt,
  type Lecture,
  type LectureProgressStatus,
} from '@/lib/catalogue';

const collator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: 'base',
});

const fmt = (value: number) => value.toLocaleString();

function courseName(lecture: Lecture) {
  return courseLabel(lecture.course);
}

function moduleName(lecture: Lecture) {
  return lecture.module.trim() || 'Course videos';
}

export type CourseGroup = {
  key: string;
  name: string;
  discipline: string;
  lectures: Lecture[];
  modules: { name: string; lectures: Lecture[] }[];
  moduleCount: number;
  sectionCount: number;
  hasUngroupedVideos: boolean;
};

export function groupCourses(lectures: Lecture[]): CourseGroup[] {
  const courses = new Map<string, Lecture[]>();
  for (const lecture of lectures) {
    const name = courseName(lecture);
    const key = `${lecture.discipline}\u0000${name}`;
    const records = courses.get(key);
    if (records) records.push(lecture);
    else courses.set(key, [lecture]);
  }

  return [...courses.entries()]
    .map(([key, records]) => {
      const sortedRecords = [...records].sort(
        (a, b) =>
          collator.compare(a.module, b.module) ||
          collator.compare(a.relativePath, b.relativePath) ||
          collator.compare(a.title, b.title),
      );
      const modules = new Map<string, Lecture[]>();
      for (const lecture of sortedRecords) {
        const name = moduleName(lecture);
        const moduleRecords = modules.get(name);
        if (moduleRecords) moduleRecords.push(lecture);
        else modules.set(name, [lecture]);
      }
      const sortedModules = [...modules.entries()]
        .sort(([a], [b]) => collator.compare(a, b))
        .map(([name, moduleRecords]) => ({
          name,
          lectures: moduleRecords.sort(
            (a, b) =>
              collator.compare(a.relativePath, b.relativePath) ||
              collator.compare(a.title, b.title),
          ),
        }));
      const moduleCount = new Set(
        sortedRecords
          .map((lecture) => lecture.module.trim())
          .filter((name) => name.length > 0),
      ).size;
      return {
        key,
        name: courseName(sortedRecords[0]),
        discipline: sortedRecords[0].discipline,
        lectures: sortedRecords,
        modules: sortedModules,
        moduleCount,
        sectionCount: sortedModules.length,
        hasUngroupedVideos:
          moduleCount > 0 &&
          sortedRecords.some((lecture) => !lecture.module.trim()),
      };
    })
    .sort(
      (a, b) =>
        collator.compare(a.discipline, b.discipline) ||
        collator.compare(a.name, b.name),
    );
}

function progressCounts(lectures: Lecture[]) {
  let seen = 0;
  let inProgress = 0;
  for (const lecture of lectures) {
    if (lecture.progressStatus === 'seen') seen++;
    if (lecture.progressStatus === 'in-progress') inProgress++;
  }
  return { seen, inProgress };
}

function timeAgo(value: string | undefined) {
  if (!value) return '';
  const elapsed = Date.now() - Date.parse(value);
  if (!Number.isFinite(elapsed) || elapsed < 0)
    return new Date(value).toLocaleDateString('en-AU');
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(value).toLocaleDateString('en-AU', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

function lecturePosition(lecture: Lecture, lectures: Lecture[]) {
  const index = lectures.findIndex((item) => item.id === lecture.id);
  return index >= 0 ? index + 1 : undefined;
}

function ProgressSelect({
  lecture,
  busy,
  onChange,
}: {
  lecture: Lecture;
  busy: boolean;
  onChange: (lecture: Lecture, status: LectureProgressStatus) => void;
}) {
  return (
    <label className={`progress-select ${lecture.progressStatus}`}>
      <span className="sr-only">Learning status for {lecture.title}</span>
      <select
        aria-label={`Learning status for ${lecture.title}`}
        value={lecture.progressStatus}
        disabled={busy}
        onChange={(event) =>
          onChange(lecture, event.target.value as LectureProgressStatus)
        }
      >
        <option value="unseen">Unseen</option>
        <option value="in-progress">In progress</option>
        <option value="seen">Seen</option>
      </select>
    </label>
  );
}

function VideoItem({
  lecture,
  number,
  busy,
  showModule = false,
  onEdit,
  onWatch,
  onProgress,
  onTag,
}: {
  lecture: Lecture;
  number?: number;
  busy: boolean;
  showModule?: boolean;
  onEdit: (lecture: Lecture) => void;
  onWatch: (lecture: Lecture) => void;
  onProgress: (lecture: Lecture, status: LectureProgressStatus) => void;
  onTag: (tag: string) => void;
}) {
  return (
    <article className="course-video-item">
      <span className={`video-status-dot ${lecture.progressStatus}`}>
        {lecture.progressStatus === 'seen' ? (
          <BookOpenCheck size={15} />
        ) : lecture.progressStatus === 'in-progress' ? (
          <Clock3 size={15} />
        ) : (
          <Circle size={12} />
        )}
      </span>
      <div className="course-video-copy">
        <button
          className="course-video-title"
          aria-label={`Edit lecture: ${lecture.title}`}
          onClick={() => onEdit(lecture)}
        >
          {number ? <span>{String(number).padStart(2, '0')}</span> : null}
          {lecture.title}
        </button>
        <div className="course-video-meta">
          {showModule && <span>{moduleName(lecture)}</span>}
          <span>{duration(lecture.duration)}</span>
          {lecture.notes.trim() && (
            <span>
              <NotebookPen size={12} /> Notes
            </span>
          )}
          {lecture.tags.map((tag) => (
            <button
              key={tag}
              className="course-video-tag"
              onClick={() => onTag(tag)}
            >
              #{tag}
            </button>
          ))}
          {lecture.youtubeUrl && (
            <span
              className={`youtube-privacy ${lecture.youtubePrivacy || 'unknown'}`}
              title={
                lecture.youtubePrivacy === 'private'
                  ? 'Only the owner and accounts invited in YouTube can watch'
                  : lecture.youtubePrivacy === 'unlisted'
                    ? 'Anyone with the link can watch'
                    : lecture.youtubePrivacy === 'public'
                      ? 'Anyone can find and watch this video'
                      : 'Refresh YouTube data to check who can watch'
              }
            >
              {lecture.youtubePrivacy === 'private' && (
                <LockKeyhole size={12} />
              )}
              {lecture.youtubePrivacy === 'private'
                ? 'Private · invited only'
                : lecture.youtubePrivacy === 'unlisted'
                  ? 'Unlisted · shareable'
                  : lecture.youtubePrivacy === 'public'
                    ? 'Public'
                    : 'Visibility not checked'}
            </span>
          )}
        </div>
      </div>
      <ProgressSelect lecture={lecture} busy={busy} onChange={onProgress} />
      {lecture.youtubeUrl ? (
        <a
          className="course-watch-button"
          aria-label={`Watch ${lecture.title} on YouTube`}
          aria-disabled={busy}
          tabIndex={busy ? -1 : undefined}
          href={lecture.youtubeUrl}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(event) => {
            if (busy) {
              event.preventDefault();
              return;
            }
            onWatch(lecture);
          }}
        >
          <Play size={14} /> Watch <ExternalLink size={12} />
        </a>
      ) : (
        <button
          className="course-add-link"
          aria-label={`Add YouTube link for ${lecture.title}`}
          onClick={() => onEdit(lecture)}
        >
          Add YouTube link
        </button>
      )}
      <button
        className="course-edit-button"
        aria-label={`Edit ${lecture.title}`}
        onClick={() => onEdit(lecture)}
      >
        Edit
      </button>
    </article>
  );
}

function CourseCard({
  course,
  matchCount,
  onOpen,
}: {
  course: CourseGroup;
  matchCount?: number;
  onOpen: (discipline: string, course: string) => void;
}) {
  const { seen, inProgress } = progressCounts(course.lectures);
  const complete = course.lectures.length
    ? Math.round((seen / course.lectures.length) * 100)
    : 0;
  const linked = course.lectures.filter((lecture) => lecture.youtubeUrl).length;
  return (
    <button
      className="course-card"
      onClick={() => onOpen(course.discipline, course.name)}
    >
      <span className="course-card-icon">
        <FolderOpen size={20} />
      </span>
      <span className="course-card-copy">
        <span className="course-card-discipline">{course.discipline}</span>
        <strong>{course.name}</strong>
        <span>
          {fmt(course.lectures.length)} video
          {course.lectures.length === 1 ? '' : 's'}
          {course.moduleCount > 0
            ? ` · ${fmt(course.hasUngroupedVideos ? course.sectionCount : course.moduleCount)} ${course.hasUngroupedVideos ? 'sections' : course.moduleCount === 1 ? 'module' : 'modules'}`
            : ''}
          {linked ? ` · ${fmt(linked)} linked` : ''}
          {matchCount !== undefined ? ` · ${fmt(matchCount)} matching` : ''}
        </span>
      </span>
      <span className="course-card-progress">
        <span>
          <span>{complete}% complete</span>
          {inProgress > 0 && <span>{inProgress} in progress</span>}
        </span>
        <span className="course-progress-track">
          <span style={{ width: `${complete}%` }} />
        </span>
      </span>
      <ChevronRight size={18} />
    </button>
  );
}

export function HistorySection({
  lectures,
  busy,
  onOpenCourse,
  onEdit,
  onWatch,
  onProgress,
}: {
  lectures: Lecture[];
  busy: boolean;
  onOpenCourse: (discipline: string, course: string) => void;
  onEdit: (lecture: Lecture) => void;
  onWatch: (lecture: Lecture) => void;
  onProgress: (lecture: Lecture, status: LectureProgressStatus) => void;
}) {
  if (!lectures.length) {
    return (
      <section className="history-section" aria-labelledby="history-heading">
        <div className="section-heading-row">
          <div>
            <span className="eyebrow">RECENT ACTIVITY</span>
            <h2 id="history-heading">Watch history</h2>
          </div>
        </div>
        <div className="history-empty">
          <Play size={19} />
          <span>
            Videos you open from the library will appear here so you can pick up
            where you left off.
          </span>
        </div>
      </section>
    );
  }
  return (
    <section className="history-section" aria-labelledby="history-heading">
      <div className="section-heading-row">
        <div>
          <span className="eyebrow">RECENT ACTIVITY</span>
          <h2 id="history-heading">Watch history</h2>
        </div>
        <span>{lectures.length} recent</span>
      </div>
      <div className="history-strip">
        {lectures.map((lecture) => (
          <article key={lecture.id} className="history-card">
            <div className="history-card-topline">
              <span className={`status-label ${lecture.progressStatus}`}>
                {lecture.progressStatus === 'in-progress'
                  ? 'In progress'
                  : lecture.progressStatus === 'seen'
                    ? 'Seen'
                    : 'Unseen'}
              </span>
              <span>{timeAgo(lastWatchedAt(lecture))}</span>
            </div>
            <button
              className="history-title"
              aria-label={`Edit lecture: ${lecture.title}`}
              onClick={() => onEdit(lecture)}
            >
              {lecture.title}
            </button>
            <button
              className="history-course"
              aria-label={`Open ${courseName(lecture)} course`}
              onClick={() =>
                onOpenCourse(lecture.discipline, courseName(lecture))
              }
            >
              {courseName(lecture)} <ChevronRight size={12} />
            </button>
            <div className="history-actions">
              <ProgressSelect
                lecture={lecture}
                busy={busy}
                onChange={onProgress}
              />
              {lecture.youtubeUrl && (
                <a
                  href={lecture.youtubeUrl}
                  aria-label={`Resume ${lecture.title} on YouTube`}
                  aria-disabled={busy}
                  tabIndex={busy ? -1 : undefined}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(event) => {
                    if (busy) {
                      event.preventDefault();
                      return;
                    }
                    onWatch(lecture);
                  }}
                >
                  <Play size={13} /> Resume
                </a>
              )}
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

export function DisciplineOverview({
  lectures,
  onOpen,
}: {
  lectures: Lecture[];
  onOpen: (discipline: string) => void;
}) {
  const courses = groupCourses(lectures);
  const disciplines = new Map<string, CourseGroup[]>();
  for (const course of courses) {
    const grouped = disciplines.get(course.discipline);
    if (grouped) grouped.push(course);
    else disciplines.set(course.discipline, [course]);
  }
  return (
    <section
      className="discipline-overview"
      aria-labelledby="disciplines-heading"
    >
      <div className="section-heading-row">
        <div>
          <span className="eyebrow">BROWSE THE LIBRARY</span>
          <h2 id="disciplines-heading">Disciplines</h2>
        </div>
        <span>{courses.length.toLocaleString()} courses</span>
      </div>
      <div className="discipline-grid">
        {[...disciplines.entries()]
          .sort(([a], [b]) => collator.compare(a, b))
          .map(([discipline, disciplineCourses], index) => {
            const videos = disciplineCourses.reduce(
              (sum, item) => sum + item.lectures.length,
              0,
            );
            const seen = disciplineCourses.reduce(
              (sum, item) => sum + progressCounts(item.lectures).seen,
              0,
            );
            return (
              <button
                key={discipline}
                className="discipline-card"
                onClick={() => onOpen(discipline)}
              >
                <span
                  className="discipline-card-accent"
                  style={
                    { '--discipline-hue': 165 + index * 23 } as CSSProperties
                  }
                />
                <span className="discipline-card-title">
                  <strong>{discipline}</strong>
                  <ChevronRight size={18} />
                </span>
                <span className="discipline-card-counts">
                  {disciplineCourses.length.toLocaleString()} courses ·{' '}
                  {videos.toLocaleString()} videos
                </span>
                <span className="discipline-course-preview">
                  {disciplineCourses.slice(0, 3).map((item) => (
                    <span key={item.key}>{item.name}</span>
                  ))}
                  {disciplineCourses.length > 3 && (
                    <span>+{disciplineCourses.length - 3} more</span>
                  )}
                </span>
                <span className="discipline-complete">
                  {seen.toLocaleString()} of {videos.toLocaleString()} seen
                </span>
              </button>
            );
          })}
      </div>
    </section>
  );
}

export function CourseList({
  lectures,
  allLectures,
  discipline,
  filtering,
  onOpen,
  onClearFilters,
}: {
  lectures: Lecture[];
  allLectures: Lecture[];
  discipline: string;
  filtering: boolean;
  onOpen: (discipline: string, course: string) => void;
  onClearFilters: () => void;
}) {
  const matchingCourses = groupCourses(lectures);
  const fullCourses = new Map(
    groupCourses(allLectures).map((item) => [item.key, item]),
  );
  if (!matchingCourses.length)
    return (
      <section className="empty-state">
        <FolderOpen size={38} />
        <h2>No courses match this search</h2>
        <p>
          Clear the search and filters to see the courses in this discipline.
        </p>
        {filtering && (
          <Button variant="outline" onClick={onClearFilters}>
            <RotateCcw size={15} /> Clear search and filters
          </Button>
        )}
      </section>
    );
  return (
    <section className="course-list-section" aria-labelledby="courses-heading">
      <div className="section-heading-row">
        <div>
          <span className="eyebrow">
            {filtering ? 'MATCHING YOUR SEARCH' : 'COURSE COLLECTION'}
          </span>
          <h2 id="courses-heading">
            {discipline || 'Courses across all disciplines'}
          </h2>
        </div>
        <span>
          {matchingCourses.length.toLocaleString()} course
          {matchingCourses.length === 1 ? '' : 's'}
        </span>
      </div>
      <div className="course-card-list">
        {matchingCourses.map((match) => (
          <CourseCard
            key={match.key}
            course={fullCourses.get(match.key) || match}
            matchCount={filtering ? match.lectures.length : undefined}
            onOpen={onOpen}
          />
        ))}
      </div>
    </section>
  );
}

export function CourseDetail({
  lectures,
  allLectures,
  discipline,
  course,
  busy,
  filtering,
  onEdit,
  onWatch,
  onProgress,
  onTag,
  onClearFilters,
}: {
  lectures: Lecture[];
  allLectures: Lecture[];
  discipline: string;
  course: string;
  busy: boolean;
  filtering: boolean;
  onEdit: (lecture: Lecture) => void;
  onWatch: (lecture: Lecture) => void;
  onProgress: (lecture: Lecture, status: LectureProgressStatus) => void;
  onTag: (tag: string) => void;
  onClearFilters: () => void;
}) {
  const selected = groupCourses(lectures).find(
    (item) => item.discipline === discipline && item.name === course,
  );
  const fullSelected = groupCourses(allLectures).find(
    (item) => item.discipline === discipline && item.name === course,
  );
  if (!selected || !fullSelected)
    return (
      <section className="empty-state">
        <Layers3 size={38} />
        <h2>No videos match these filters</h2>
        <p>The course is still here. Clear the filters to show every video.</p>
        {filtering && (
          <Button variant="outline" onClick={onClearFilters}>
            <RotateCcw size={15} /> Show all course videos
          </Button>
        )}
      </section>
    );

  const { seen, inProgress } = progressCounts(fullSelected.lectures);
  const hasNamedModules = fullSelected.sectionCount > 1;
  const moduleGroups = hasNamedModules
    ? selected.modules
    : [{ name: 'Course videos', lectures: selected.lectures }];
  const displayedSectionCount = fullSelected.hasUngroupedVideos
    ? fullSelected.sectionCount
    : fullSelected.moduleCount;

  return (
    <section className="course-detail" aria-label={`${course} course videos`}>
      <div className="course-summary">
        <div>
          <span>{fullSelected.lectures.length.toLocaleString()}</span>
          <small>videos</small>
        </div>
        <div>
          <span>{displayedSectionCount.toLocaleString()}</span>
          <small>
            {fullSelected.hasUngroupedVideos
              ? 'sections'
              : displayedSectionCount === 1
                ? 'module'
                : 'modules'}
          </small>
        </div>
        <div>
          <span>{seen.toLocaleString()}</span>
          <small>seen</small>
        </div>
        <div>
          <span>{inProgress.toLocaleString()}</span>
          <small>in progress</small>
        </div>
      </div>
      {filtering && (
        <div className="course-match-note">
          <span>
            Showing {selected.lectures.length.toLocaleString()} of{' '}
            {fullSelected.lectures.length.toLocaleString()} videos
          </span>
          <button onClick={onClearFilters}>Show all course videos</button>
        </div>
      )}
      {moduleGroups.map((module, moduleIndex) =>
        hasNamedModules ? (
          <details
            className="module-section"
            key={module.name}
            open={moduleIndex === 0}
          >
            <summary>
              <span className="module-icon">
                <Layers3 size={17} />
              </span>
              <span>
                <strong>{module.name}</strong>
                <small>
                  {module.lectures.length.toLocaleString()} video
                  {module.lectures.length === 1 ? '' : 's'}
                </small>
              </span>
              <ChevronRight size={18} />
            </summary>
            <div className="module-videos">
              {module.lectures.map((lecture) => (
                <VideoItem
                  key={lecture.id}
                  lecture={lecture}
                  number={lecturePosition(
                    lecture,
                    fullSelected.modules.find(
                      (fullModule) => fullModule.name === module.name,
                    )?.lectures || module.lectures,
                  )}
                  busy={busy}
                  onEdit={onEdit}
                  onWatch={onWatch}
                  onProgress={onProgress}
                  onTag={onTag}
                />
              ))}
            </div>
          </details>
        ) : (
          <div className="module-section ungrouped" key={module.name}>
            <div className="module-videos">
              {module.lectures.map((lecture) => (
                <VideoItem
                  key={lecture.id}
                  lecture={lecture}
                  number={lecturePosition(lecture, fullSelected.lectures)}
                  busy={busy}
                  onEdit={onEdit}
                  onWatch={onWatch}
                  onProgress={onProgress}
                  onTag={onTag}
                />
              ))}
            </div>
          </div>
        ),
      )}
    </section>
  );
}
