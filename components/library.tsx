'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  BookOpen,
  ChevronLeft,
  ChevronRight,
  CloudUpload,
  Download,
  FolderOpen,
  Home,
  LibraryBig,
  LockKeyhole,
  NotebookPen,
  Play,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  ShieldCheck,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import {
  SidebarProvider,
  Sidebar,
  SidebarHeader,
  SidebarContent,
  SidebarFooter,
  SidebarInset,
  SidebarTrigger,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
} from '@/components/ui/sidebar';
import { Choice } from '@/components/choice';
import { LectureEditor, duration } from '@/components/lecture-editor';
import { LecturePage } from '@/components/lecture-page';
import {
  CourseDetail,
  CourseList,
  DisciplineOverview,
  HistorySection,
  courseKeyForLecture,
} from '@/components/course-browser';
import {
  DISCIPLINES,
  compareLectures,
  filterLectures,
  recentlyWatched,
  recordLectureWatch,
  setLectureProgress,
  mergeCatalogues,
  validateCatalogue,
  type Catalogue,
  type Lecture,
  type LectureProgressStatus,
} from '@/lib/catalogue';
import {
  fingerprint,
  openWithSession,
  seal,
  type VaultSession,
} from '@/lib/vault';
import { writeDraft } from '@/lib/storage';
import { pushGithub, readGithub, type GithubConfig } from '@/lib/github';
import {
  applyYoutubeUpdates,
  fetchYoutubeUpdates,
} from '@/lib/youtube-sync';
export type Opened = {
  catalogue: Catalogue;
  session: VaultSession;
  baseline: string;
  dirty: boolean;
  notice: string;
};
const fmt = (n: number) => n.toLocaleString();
const msg = (e: unknown) =>
  e instanceof Error ? e.message : 'Something went wrong. Please try again.';
function lectureIdFromHash() {
  if (typeof window === 'undefined') return '';
  const match = /^#\/lecture\/(.+)$/.exec(window.location.hash);
  if (!match) return '';
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return '';
  }
}
export default function Library({
  initial,
  lock,
}: {
  initial: Opened;
  lock: () => void;
}) {
  const [data, setData] = useState(initial.catalogue);
  const [baseline, setBaseline] = useState(initial.baseline);
  const [dirty, setDirty] = useState(initial.dirty);
  const [notice, setNotice] = useState(initial.notice);
  const [saveStatus, setSaveStatus] = useState(
    initial.dirty ? 'Unpublished changes' : 'Shared library up to date',
  );
  const [busy, setBusy] = useState(false);
  const [youtubeRefreshing, setYoutubeRefreshing] = useState(false);
  const [view, setView] = useState('lectures');
  const [query, setQuery] = useState('');
  const [discipline, setDiscipline] = useState('');
  const [source, setSource] = useState('');
  const [status, setStatus] = useState('');
  const [tag, setTag] = useState('');
  const [course, setCourse] = useState('');
  const [courseKey, setCourseKey] = useState('');
  const [selectedLectureId, setSelectedLectureId] = useState(
    lectureIdFromHash,
  );
  const [progress, setProgress] = useState('');
  const [sort, setSort] = useState('linked');
  const [pagination, setPagination] = useState({ key: '', page: 1 });
  const [editing, setEditing] = useState<Lecture | null>(null);
  const [settings, setSettings] = useState(false);
  const [settingsError, setSettingsError] = useState('');
  const [config, setConfig] = useState<GithubConfig>({
    repo: 'ziliangli2018-cyber/cpd-library',
    branch: 'main',
    token: '',
  });
  const fileInput = useRef<HTMLInputElement>(null);
  const dataRef = useRef(data);
  const saveQueue = useRef<Promise<void>>(Promise.resolve());
  const pendingSaves = useRef(0);
  useEffect(() => {
    function followBrowserRoute() {
      const id = lectureIdFromHash();
      const lecture = dataRef.current.lectures.find((item) => item.id === id);
      if (!lecture) {
        setSelectedLectureId('');
        return;
      }
      setView('lectures');
      setDiscipline(lecture.discipline);
      setCourse(lecture.course);
      setCourseKey(courseKeyForLecture(lecture));
      setSelectedLectureId(lecture.id);
    }
    followBrowserRoute();
    window.addEventListener('hashchange', followBrowserRoute);
    window.addEventListener('popstate', followBrowserRoute);
    return () => {
      window.removeEventListener('hashchange', followBrowserRoute);
      window.removeEventListener('popstate', followBrowserRoute);
    };
  }, []);
  const filterKey = JSON.stringify([
    query,
    discipline,
    source,
    status,
    tag,
    course,
    courseKey,
    progress,
    sort,
    view,
  ]);
  const page = pagination.key === filterKey ? pagination.page : 1;
  function setPage(next: number) {
    setPagination({ key: filterKey, page: next });
  }
  const counts = useMemo(
    () =>
      new Map(
        DISCIPLINES.map((d) => [
          d,
          data.lectures.filter((v) => v.discipline === d).length,
        ]),
      ),
    [data],
  );
  const linked = data.lectures.filter((v) => v.youtubeUrl).length;
  const noted = data.lectures.filter((v) => v.notes.trim()).length;
  const seen = data.lectures.filter(
    (lecture) => lecture.progressStatus === 'seen',
  ).length;
  const inProgress = data.lectures.filter(
    (lecture) => lecture.progressStatus === 'in-progress',
  ).length;
  const history = useMemo(() => recentlyWatched(data.lectures, 8), [data]);
  const selectedLecture = selectedLectureId
    ? data.lectures.find((lecture) => lecture.id === selectedLectureId) || null
    : null;
  const isFiltering = Boolean(query || source || status || tag || progress);
  const pageTitle = selectedLecture
    ? selectedLecture.title
    : view === 'notes'
      ? 'Lecture notes'
      : view === 'textbooks'
        ? 'Textbooks'
        : course || discipline || 'Learning home';
  const pageDescription = selectedLecture
    ? [selectedLecture.course, selectedLecture.module].filter(Boolean).join(' · ')
    : view === 'notes'
      ? 'Your observations, linked to the lectures they came from.'
      : view === 'textbooks'
        ? 'A dedicated home for your reading and reference notes.'
        : course
          ? 'Work through the course by module and keep your place as you learn.'
          : discipline
            ? 'Choose a course to see its modules and videos.'
            : 'Pick up where you left off or browse your courses by discipline.';
  useEffect(() => {
    document.title = `${pageTitle} · Dental Library`;
    document.querySelector<HTMLElement>('.page-heading h1')?.focus();
  }, [pageTitle]);
  const sources = [...new Set(data.lectures.map((v) => v.source))];
  const tags = useMemo(() => {
    const map = new Map<string, number>();
    for (const v of data.lectures)
      for (const t of v.tags) map.set(t, (map.get(t) || 0) + 1);
    return [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
  }, [data]);
  const filtered = useMemo(
    () =>
      filterLectures(
        view === 'notes'
          ? data.lectures.filter((v) => v.notes.trim())
          : data.lectures,
        { query, discipline, source, status, tag, course: '' },
      )
        .filter(
          (lecture) =>
            !courseKey || courseKeyForLecture(lecture) === courseKey,
        )
        .filter((lecture) => !progress || lecture.progressStatus === progress)
        .sort((a, b) =>
          compareLectures(
            a,
            b,
            sort as 'linked' | 'course' | 'title' | 'updated',
          ),
        ),
    [
      data,
      view,
      query,
      discipline,
      source,
      status,
      tag,
      courseKey,
      progress,
      sort,
    ],
  );
  const totalPages = Math.max(1, Math.ceil(filtered.length / 30));
  const currentPage = Math.min(page, totalPages);
  const rows = filtered.slice((currentPage - 1) * 30, currentPage * 30);
  function clearFilters() {
    setQuery('');
    setDiscipline('');
    setSource('');
    setStatus('');
    setTag('');
    setCourse('');
    setCourseKey('');
    setSelectedLectureId('');
    clearLectureRoute();
    setProgress('');
  }
  function clearSearchFilters() {
    setQuery('');
    setSource('');
    setStatus('');
    setTag('');
    setProgress('');
  }
  function nav(v: string) {
    setView(v);
    setSort(v === 'notes' ? 'updated' : 'linked');
    clearFilters();
  }
  function openDiscipline(nextDiscipline: string) {
    setView('lectures');
    setDiscipline(nextDiscipline);
    setCourse('');
    setCourseKey('');
    setSelectedLectureId('');
    clearLectureRoute();
  }
  function openCourse(
    nextCourseKey: string,
    nextDiscipline: string,
    nextCourse: string,
  ) {
    setView('lectures');
    setDiscipline(nextDiscipline);
    setCourse(nextCourse);
    setCourseKey(nextCourseKey);
    setSelectedLectureId('');
    clearLectureRoute();
  }
  function openLecture(lecture: Lecture) {
    setView('lectures');
    setDiscipline(lecture.discipline);
    setCourse(lecture.course);
    setCourseKey(courseKeyForLecture(lecture));
    setSelectedLectureId(lecture.id);
    const hash = `#/lecture/${encodeURIComponent(lecture.id)}`;
    if (window.location.hash !== hash)
      window.history.pushState({ lectureId: lecture.id }, '', hash);
  }
  function clearLectureRoute() {
    if (typeof window === 'undefined' || !window.location.hash.startsWith('#/lecture/'))
      return;
    window.history.pushState(
      null,
      '',
      `${window.location.pathname}${window.location.search}`,
    );
  }
  async function save(next: Catalogue) {
    dataRef.current = next;
    pendingSaves.current += 1;
    setBusy(true);
    setData(next);
    setDirty(true);
    setSaveStatus('Saving encrypted draft…');
    const operation = saveQueue.current
      .catch(() => undefined)
      .then(async () => {
        await writeDraft({
          envelope: await seal(next, initial.session),
          baseline,
          dirty: true,
        });
      });
    saveQueue.current = operation;
    let saved = false;
    try {
      await operation;
      saved = true;
    } catch (e) {
      setSaveStatus('Changes in memory only');
      setNotice(msg(e));
    } finally {
      pendingSaves.current -= 1;
      if (pendingSaves.current === 0) {
        setBusy(false);
        if (saved) setSaveStatus('Encrypted draft saved in this browser');
      }
    }
  }
  async function saveLecture(v: Lecture) {
    const current = dataRef.current;
    const previous = current.lectures.find((x) => x.id === v.id);
    const exists = !!previous;
    const taxonomyChanged =
      !!previous &&
      (previous.course !== v.course ||
        previous.discipline !== v.discipline);
    const taxonomyUpdatedAt =
      v.taxonomyUpdatedAt || new Date().toISOString();
    await save({
      ...current,
      updatedAt: new Date().toISOString(),
      lectures: exists
        ? current.lectures.map((x) => {
            if (x.id === v.id) return v;
            if (!taxonomyChanged || x.courseKey !== previous.courseKey)
              return x;
            return {
              ...x,
              course: v.course,
              discipline: v.discipline,
              classificationReviewed: true,
              taxonomySource: 'manual' as const,
              taxonomyUpdatedAt,
            };
          })
        : [v, ...current.lectures],
    });
    if (previous && courseKey === previous.courseKey) {
      setCourse(v.course);
      setDiscipline(v.discipline);
    }
    setEditing(null);
  }
  async function updateLecture(v: Lecture) {
    const current = dataRef.current;
    await save({
      ...current,
      updatedAt: new Date().toISOString(),
      lectures: current.lectures.map((lecture) =>
        lecture.id === v.id ? v : lecture,
      ),
    });
  }
  function updateProgress(lecture: Lecture, nextStatus: LectureProgressStatus) {
    const current =
      dataRef.current.lectures.find((item) => item.id === lecture.id) ||
      lecture;
    void updateLecture(
      setLectureProgress(current, nextStatus, new Date().toISOString()),
    );
  }
  function recordWatch(lecture: Lecture) {
    const current =
      dataRef.current.lectures.find((item) => item.id === lecture.id) ||
      lecture;
    void updateLecture(recordLectureWatch(current, new Date().toISOString()));
  }
  async function saveNotes(lectureId: string, notes: string) {
    const current = dataRef.current.lectures.find(
      (lecture) => lecture.id === lectureId,
    );
    if (!current || current.notes === notes) return;
    await updateLecture({
      ...current,
      notes,
      updatedAt: new Date().toISOString(),
    });
  }
  async function refreshYoutube() {
    setBusy(true);
    setYoutubeRefreshing(true);
    setNotice('Checking the uploader and YouTube for current links…');
    try {
      const result = await fetchYoutubeUpdates();
      const applied = applyYoutubeUpdates(dataRef.current, result);
      if (!applied.changes) {
        setNotice(
          `YouTube is already current across ${fmt(result.summary.matched || 0)} matched videos.`,
        );
        return;
      }
      await save(applied.catalogue);
      const details = [
        result.summary.newLinks
          ? `${fmt(result.summary.newLinks)} new link${result.summary.newLinks === 1 ? '' : 's'}`
          : '',
        result.summary.privacyChanges
          ? `${fmt(result.summary.privacyChanges)} visibility change${result.summary.privacyChanges === 1 ? '' : 's'}`
          : '',
        result.summary.titleChanges
          ? `${fmt(result.summary.titleChanges)} title change${result.summary.titleChanges === 1 ? '' : 's'}`
          : '',
      ].filter(Boolean);
      setNotice(
        `YouTube updated ${fmt(applied.changes)} lecture${applied.changes === 1 ? '' : 's'}${details.length ? `: ${details.join(', ')}` : ''}. Publish the encrypted changes in Library settings when ready.`,
      );
    } catch (e) {
      setNotice(msg(e));
    } finally {
      setYoutubeRefreshing(false);
      if (pendingSaves.current === 0) setBusy(false);
    }
  }
  function addLecture() {
    const now = new Date().toISOString();
    setEditing({
      id: crypto.randomUUID(),
      title: '',
      course,
      courseKey: courseKey || crypto.randomUUID(),
      module: '',
      discipline: discipline || 'General dentistry',
      tags: [],
      youtubeUrl: '',
      notes: '',
      source: 'Manually added',
      relativePath: '',
      duration: null,
      bytes: 0,
      importedAt: now,
      updatedAt: now,
      classificationReviewed: true,
      taxonomySource: 'manual',
      taxonomyUpdatedAt: now,
      availability: 'Added manually',
      progressStatus: 'unseen',
      watchHistory: [],
    });
  }
  async function exportBackup() {
    setBusy(true);
    try {
      const envelope = await seal(data, initial.session);
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(envelope)], { type: 'application/json' }),
      );
      const a = document.createElement('a');
      a.href = url;
      a.download = `dental-library-${new Date().toISOString().slice(0, 10)}.enc.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      setNotice(
        'Encrypted backup downloaded. Keep it with your library password.',
      );
    } catch (e) {
      setNotice(msg(e));
    } finally {
      setBusy(false);
    }
  }
  async function importBackup(file: File) {
    setBusy(true);
    setSettingsError('');
    try {
      if (file.size > 80_000_000) throw new Error('That backup is too large.');
      const imported = validateCatalogue(
        await openWithSession(JSON.parse(await file.text()), initial.session),
      );
      const { catalogue: merged, changes } = mergeCatalogues(
        dataRef.current,
        imported,
      );
      await save(merged);
      setNotice(
        `Merged ${fmt(changes)} updates. Newer edits and source scan information were retained.`,
      );
      setSettings(false);
      setConfig((c) => ({ ...c, token: '' }));
    } catch (e) {
      setSettingsError(msg(e));
    } finally {
      setBusy(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  }
  async function publish() {
    setBusy(true);
    setSettingsError('');
    try {
      const envelope = await seal(dataRef.current, initial.session);
      await pushGithub(config, envelope, baseline);
      const nextBaseline = await fingerprint(envelope);
      setBaseline(nextBaseline);
      setDirty(false);
      setSaveStatus('Saved to GitHub');
      try {
        await writeDraft({ envelope, baseline: nextBaseline, dirty: false });
      } catch {
        setSettingsError(
          'Saved to GitHub, but this browser could not update its cached draft.',
        );
        return;
      }
      setNotice(
        'Saved to GitHub. The hosted library will update when its deployment finishes.',
      );
      setSettings(false);
      setConfig((c) => ({ ...c, token: '' }));
    } catch (e) {
      setSettingsError(msg(e));
    } finally {
      setBusy(false);
    }
  }
  async function loadLatest() {
    setBusy(true);
    setSettingsError('');
    try {
      const remote = await readGithub(config);
      const latest = validateCatalogue(
        await openWithSession(remote.envelope, initial.session),
      );
      const nextBaseline = await fingerprint(remote.envelope);
      const { catalogue: next, changes: wins } = dirty
        ? mergeCatalogues(latest, dataRef.current)
        : { catalogue: latest, changes: 0 };
      await writeDraft({
        envelope: await seal(next, initial.session),
        baseline: nextBaseline,
        dirty: wins > 0,
      });
      setData(next);
      dataRef.current = next;
      setBaseline(nextBaseline);
      setDirty(wins > 0);
      setSaveStatus(
        wins
          ? 'Merged draft saved in this browser'
          : 'Shared library up to date',
      );
      setNotice(
        wins
          ? `Latest library loaded; ${wins} newer local lectures retained. Review the merged library before publishing.`
          : 'Latest library loaded from GitHub.',
      );
      setSettings(false);
      setConfig((c) => ({ ...c, token: '' }));
    } catch (e) {
      setSettingsError(msg(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <SidebarProvider>
      <Sidebar className="library-sidebar" collapsible="offcanvas">
        <SidebarHeader className="brand-header">
          <div className="brand-mark">
            <LibraryBig size={25} />
          </div>
          <div>
            <strong>Dental Library</strong>
            <span>PERSONAL COLLECTION</span>
          </div>
        </SidebarHeader>
        <SidebarContent>
          <div className="sidebar-label">WORKSPACE</div>
          <SidebarMenu className="main-nav">
            {[
              {
                id: 'lectures',
                label: 'Learning home',
                icon: Home,
                count: data.lectures.length,
              },
              {
                id: 'notes',
                label: 'Lecture notes',
                icon: NotebookPen,
                count: noted,
              },
              { id: 'textbooks', label: 'Textbooks', icon: BookOpen, count: 0 },
            ].map((n) => (
              <SidebarMenuItem key={n.id}>
                <SidebarMenuButton
                  isActive={view === n.id}
                  aria-current={view === n.id ? 'page' : undefined}
                  onClick={() => nav(n.id)}
                >
                  <n.icon size={18} />
                  <span>{n.label}</span>
                  <span className="nav-count">
                    {n.id === 'textbooks' ? 'Later' : fmt(n.count)}
                  </span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            ))}
          </SidebarMenu>
          <div className="sidebar-label discipline-label">
            DISCIPLINES <span>{DISCIPLINES.length}</span>
          </div>
          <SidebarMenu className="discipline-nav">
            <SidebarMenuItem>
              <SidebarMenuButton
                isActive={view === 'lectures' && !discipline}
                aria-current={
                  view === 'lectures' && !discipline ? 'page' : undefined
                }
                onClick={() => {
                  setDiscipline('');
                  setCourse('');
                  setCourseKey('');
                  setSelectedLectureId('');
                  clearLectureRoute();
                  setView('lectures');
                }}
              >
                <span className="discipline-dot all-dot" />
                <span>All disciplines</span>
                <span className="nav-count">{fmt(data.lectures.length)}</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
            {DISCIPLINES.map((d, i) => (
              <SidebarMenuItem key={d}>
                <SidebarMenuButton
                  isActive={view === 'lectures' && discipline === d}
                  aria-current={
                    view === 'lectures' && discipline === d ? 'page' : undefined
                  }
                  onClick={() => openDiscipline(d)}
                >
                  <span
                    className="discipline-dot"
                    style={{ background: `hsl(${165 + i * 23} 48% 68%)` }}
                  />
                  <span>{d}</span>
                  <span className="nav-count">{fmt(counts.get(d) || 0)}</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            ))}
          </SidebarMenu>
          <div className="sidebar-label discipline-label">EXPLORE TAGS</div>
          <div className="sidebar-tags">
            {tags.map(([t]) => (
              <button
                key={t}
                className={tag === t ? 'active' : ''}
                aria-pressed={tag === t}
                onClick={() => {
                  setTag(tag === t ? '' : t);
                  setCourse('');
                  setCourseKey('');
                  setSelectedLectureId('');
                  clearLectureRoute();
                  setView('lectures');
                }}
              >
                # {t}
              </button>
            ))}
          </div>
        </SidebarContent>
        <SidebarFooter className="sidebar-footer">
          <div className="privacy-note">
            <ShieldCheck size={18} />
            <div>
              <strong>Password protected</strong>
              <span>Share with people you choose</span>
            </div>
          </div>
          <button className="lock-button" onClick={lock}>
            <LockKeyhole size={16} /> Lock library
          </button>
        </SidebarFooter>
      </Sidebar>
      <SidebarInset className="library-main">
        <header className="topbar">
          <nav className="breadcrumb" aria-label="Breadcrumb">
            <SidebarTrigger />
            {view === 'lectures' ? (
              <>
                <button onClick={() => nav('lectures')}>Home</button>
                {discipline && (
                  <>
                    <ChevronRight size={14} />
                    <button onClick={() => openDiscipline(discipline)}>
                      {discipline}
                    </button>
                  </>
                )}
                {course && (
                  <>
                    <ChevronRight size={14} />
                    {selectedLecture ? (
                      <button
                        onClick={() => {
                          setSelectedLectureId('');
                          clearLectureRoute();
                          setView('lectures');
                        }}
                      >
                        {course}
                      </button>
                    ) : (
                      <strong>{course}</strong>
                    )}
                  </>
                )}
                {selectedLecture && (
                  <>
                    <ChevronRight size={14} />
                    <strong>{selectedLecture.title}</strong>
                  </>
                )}
              </>
            ) : (
              <>
                <span>Workspace</span>
                <ChevronRight size={14} />
                <strong>{pageTitle}</strong>
              </>
            )}
          </nav>
          <div className="topbar-actions">
            <span className="private-badge">
              <span /> Private content
            </span>
            <Button
              className="youtube-refresh-button"
              variant="outline"
              onClick={() => void refreshYoutube()}
              disabled={busy}
            >
              <RefreshCw
                size={16}
                className={youtubeRefreshing ? 'spin' : undefined}
              />
              <span>{youtubeRefreshing ? 'Updating…' : 'Update YouTube'}</span>
            </Button>
            <Button
              variant="outline"
              onClick={() => {
                setSettingsError('');
                setSettings(true);
              }}
            >
              <Settings2 size={16} />
              <span>Library settings</span>
            </Button>
          </div>
        </header>
        <div className="content-area">
          <div className="page-heading">
            <div>
              <div className="eyebrow">YOUR KNOWLEDGE, CONNECTED</div>
              <h1 tabIndex={-1}>{pageTitle}</h1>
              <p>{pageDescription}</p>
            </div>
            {view === 'lectures' && !selectedLecture && (
              <Button
                className="primary-btn"
                onClick={addLecture}
                disabled={busy}
              >
                <Plus size={18} /> Add lecture
              </Button>
            )}
          </div>
          {notice && (
            <output className="notice">
              <span>{notice}</span>
              <button
                aria-label="Dismiss notification"
                onClick={() => setNotice('')}
              >
                <X size={16} />
              </button>
            </output>
          )}
          {view === 'textbooks' ? (
            <section className="future-section">
              <BookOpen size={44} />
              <span className="eyebrow">THE NEXT CHAPTER</span>
              <h2>Your reference shelf</h2>
              <p>
                This section is reserved for textbooks and their notes. When
                you’re ready, books can sit alongside your lectures with the
                same searchable disciplines and tags.
              </p>
              <div className="future-meta">
                <FolderOpen size={18} />
                {fmt(data.importSummary?.documents || 0)} documents found in the
                source folders, ready for later review.
              </div>
            </section>
          ) : selectedLecture ? (
            <LecturePage
              key={selectedLecture.id}
              lecture={selectedLecture}
              busy={busy}
              onEdit={setEditing}
              onWatch={recordWatch}
              onProgress={updateProgress}
              onSaveNotes={saveNotes}
            />
          ) : (
            <>
              <div className="collection-overview">
                <div className="overview-icon">
                  <LibraryBig size={26} />
                </div>
                <div className="overview-total">
                  <strong>{fmt(data.lectures.length)}</strong>
                  <span>lectures in your collection</span>
                </div>
                <div className="overview-divider" />
                <button
                  onClick={() => {
                    clearFilters();
                    setProgress('in-progress');
                    setView('lectures');
                  }}
                >
                  <span className="stat-dot in-progress" />
                  <strong>{fmt(inProgress)}</strong> in progress
                </button>
                <button
                  onClick={() => {
                    clearFilters();
                    setProgress('seen');
                    setView('lectures');
                  }}
                >
                  <span className="stat-dot seen" />
                  <strong>{fmt(seen)}</strong> seen
                </button>
                <button
                  onClick={() => {
                    clearFilters();
                    setStatus('linked');
                    setView('lectures');
                  }}
                >
                  <span className="stat-dot linked" />
                  <strong>{fmt(linked)}</strong> YouTube linked
                </button>
                <div className="overview-save">
                  <ShieldCheck size={15} />
                  <span>{saveStatus}</span>
                </div>
              </div>
              <section className="search-panel">
                <div className="search-box">
                  <Search size={20} />
                  <Input
                    aria-label="Search lectures, courses, disciplines and tags"
                    placeholder="Search lectures, courses or #tags…"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                  />
                  {query && (
                    <button
                      aria-label="Clear search"
                      onClick={() => setQuery('')}
                    >
                      <X size={17} />
                    </button>
                  )}
                </div>
                <div className="filters">
                  <Choice
                    label="All sources"
                    value={source}
                    onChange={setSource}
                    options={[
                      { value: '', label: 'All sources' },
                      ...sources.map((s) => ({ value: s, label: s })),
                    ]}
                  />
                  <Choice
                    label="Any link status"
                    value={status}
                    onChange={setStatus}
                    options={[
                      { value: '', label: 'Any link status' },
                      { value: 'linked', label: 'YouTube linked' },
                      { value: 'pending', label: 'Awaiting a link' },
                      { value: 'review', label: 'Discipline needs review' },
                    ]}
                  />
                  <Choice
                    label="Any learning status"
                    value={progress}
                    onChange={setProgress}
                    options={[
                      { value: '', label: 'Any learning status' },
                      { value: 'unseen', label: 'Unseen' },
                      { value: 'in-progress', label: 'In progress' },
                      { value: 'seen', label: 'Seen' },
                    ]}
                  />
                  <div className="filter-spacer" />
                  {view === 'notes' && (
                    <Choice
                      label="Recently edited"
                      value={sort}
                      onChange={setSort}
                      options={[
                        { value: 'updated', label: 'Recently edited' },
                        { value: 'course', label: 'Sort by course' },
                        { value: 'title', label: 'Title A–Z' },
                      ]}
                    />
                  )}
                </div>
                {isFiltering && (
                  <div className="active-filters">
                    {tag && (
                      <button onClick={() => setTag('')}>
                        # {tag}
                        <X size={13} />
                      </button>
                    )}
                    {progress && (
                      <button onClick={() => setProgress('')}>
                        {progress === 'in-progress' ? 'In progress' : progress}
                        <X size={13} />
                      </button>
                    )}
                    <button
                      className="clear-filters"
                      onClick={clearSearchFilters}
                    >
                      Clear search and filters
                    </button>
                  </div>
                )}
              </section>
              {view === 'lectures' &&
                (course ? (
                  <CourseDetail
                    lectures={filtered}
                    allLectures={data.lectures}
                    discipline={discipline}
                    course={course}
                    courseKey={courseKey}
                    busy={busy}
                    filtering={isFiltering}
                    onEdit={setEditing}
                    onOpenLecture={openLecture}
                    onProgress={updateProgress}
                    onTag={setTag}
                    onClearFilters={clearSearchFilters}
                  />
                ) : discipline || isFiltering ? (
                  <CourseList
                    lectures={filtered}
                    allLectures={data.lectures}
                    discipline={discipline}
                    filtering={isFiltering}
                    onOpen={openCourse}
                    onClearFilters={clearSearchFilters}
                  />
                ) : (
                  <>
                    <HistorySection
                      lectures={history}
                      busy={busy}
                      onOpenCourse={(
                        nextCourseKey,
                        nextDiscipline,
                        nextCourse,
                      ) => {
                        clearSearchFilters();
                        openCourse(
                          nextCourseKey,
                          nextDiscipline,
                          nextCourse,
                        );
                      }}
                      onOpenLecture={openLecture}
                      onProgress={updateProgress}
                    />
                    <DisciplineOverview
                      lectures={data.lectures}
                      onOpen={(nextDiscipline) => {
                        clearSearchFilters();
                        openDiscipline(nextDiscipline);
                      }}
                    />
                  </>
                ))}
              {view === 'notes' && (
                <>
                  <div className="results-heading">
                    <span>
                      <strong>{fmt(filtered.length)}</strong>{' '}
                      {view === 'notes' ? 'lecture notes' : 'lectures'}
                      {discipline && ` in ${discipline}`}
                    </span>
                    <span className="classification-hint">
                      <span className="tiny-dot" /> Courses follow their source
                      folders · discipline editable by course
                    </span>
                  </div>
                  {rows.length ? (
                    <section
                      className="lecture-list"
                      aria-label="Lecture results"
                    >
                      <div className="list-header">
                        <span>LECTURE & COURSE</span>
                        <span>DISCIPLINE & TAGS</span>
                        <span>YOUTUBE</span>
                      </div>
                      {rows.map((v, i) => (
                        <article key={v.id} className="lecture-row">
                          <div className="lecture-info">
                            {v.youtubeUrl ? (
                              <button
                                className="play-tile linked-play-tile"
                                aria-label={`Open lecture: ${v.title}`}
                                onClick={() => openLecture(v)}
                              >
                                <Play size={19} />
                                <span>WATCH</span>
                              </button>
                            ) : (
                              <button
                                className="play-tile"
                                aria-label={`Open lecture: ${v.title}`}
                                onClick={() => openLecture(v)}
                              >
                                <Plus size={19} />
                                <span>
                                  {String(
                                    (currentPage - 1) * 30 + i + 1,
                                  ).padStart(2, '0')}
                                </span>
                              </button>
                            )}
                            <div className="lecture-copy">
                              <button
                                className="lecture-title"
                                onClick={() => openLecture(v)}
                              >
                                {v.title}
                              </button>
                              <button
                                className="course-link"
                                onClick={() =>
                                  openCourse(
                                    courseKeyForLecture(v),
                                    v.discipline,
                                    v.course,
                                  )
                                }
                              >
                                {v.course}
                              </button>
                              <div className="lecture-meta">
                                <span>{v.source}</span>
                                <span>·</span>
                                <span>{duration(v.duration)}</span>
                                {v.notes && <NotebookPen size={13} />}
                              </div>
                              {view === 'notes' && (
                                <p className="note-preview">
                                  {v.notes.slice(0, 180)}
                                </p>
                              )}
                            </div>
                          </div>
                          <div className="lecture-taxonomy">
                            <button
                              className="discipline-pill"
                              onClick={() => {
                                setDiscipline(v.discipline);
                                setCourse('');
                                setCourseKey('');
                                setSelectedLectureId('');
                                clearLectureRoute();
                              }}
                            >
                              {v.discipline}
                            </button>
                            <div className="row-tags">
                              {v.tags.slice(0, 3).map((t) => (
                                <button key={t} onClick={() => setTag(t)}>
                                  #{t}
                                </button>
                              ))}
                              {v.tags.length > 3 && (
                                <span>+{v.tags.length - 3}</span>
                              )}
                            </div>
                          </div>
                          <div className="lecture-link">
                            {v.youtubeUrl ? (
                              <button
                                className="watch-link"
                                onClick={() => openLecture(v)}
                              >
                                <Play size={14} /> Open video
                              </button>
                            ) : (
                              <button
                                className="add-link"
                                onClick={() => setEditing(v)}
                              >
                                <Plus size={15} /> Add link
                              </button>
                            )}
                            {v.youtubeUrl && (
                              <span
                                className={`youtube-privacy ${v.youtubePrivacy || 'unknown'}`}
                                title={
                                  v.youtubePrivacy === 'private'
                                    ? 'Only the owner and accounts invited in YouTube can watch'
                                    : v.youtubePrivacy === 'unlisted'
                                      ? 'Anyone with the link can watch'
                                      : v.youtubePrivacy === 'public'
                                        ? 'Anyone can find and watch this video'
                                        : 'Refresh YouTube data to check who can watch'
                                }
                              >
                                {v.youtubePrivacy === 'private' && (
                                  <LockKeyhole size={12} />
                                )}
                                {v.youtubePrivacy === 'private'
                                  ? 'Private · invited only'
                                  : v.youtubePrivacy === 'unlisted'
                                    ? 'Unlisted · shareable'
                                    : v.youtubePrivacy === 'public'
                                      ? 'Public'
                                      : 'Visibility not checked'}
                              </span>
                            )}
                            <button
                              className="edit-link"
                              onClick={() => setEditing(v)}
                            >
                              Edit details <ChevronRight size={12} />
                            </button>
                          </div>
                        </article>
                      ))}
                    </section>
                  ) : (
                    <section className="empty-state">
                      {view === 'notes' ? (
                        <NotebookPen size={38} />
                      ) : (
                        <Search size={38} />
                      )}
                      <h2>
                        {view === 'notes' && !noted
                          ? 'Your notes start with a lecture'
                          : 'No lectures match these filters'}
                      </h2>
                      <p>
                        {view === 'notes' && !noted
                          ? 'Open a lecture and add your notes. They will appear here, together with their source.'
                          : 'Try another keyword or clear the filters to see your collection.'}
                      </p>
                      <Button
                        variant="outline"
                        onClick={() =>
                          view === 'notes' && !noted
                            ? nav('lectures')
                            : clearFilters()
                        }
                      >
                        {view === 'notes' && !noted
                          ? 'Browse lectures'
                          : 'Clear filters'}
                      </Button>
                    </section>
                  )}
                  {filtered.length > 0 && (
                    <div className="pagination-bar">
                      <span>
                        Showing {fmt((currentPage - 1) * 30 + 1)}–
                        {fmt(Math.min(currentPage * 30, filtered.length))} of{' '}
                        {fmt(filtered.length)}
                      </span>
                      <div>
                        <Button
                          variant="outline"
                          aria-label="Previous page"
                          disabled={currentPage === 1}
                          onClick={() => setPage(currentPage - 1)}
                        >
                          <ChevronLeft size={16} />
                        </Button>
                        <span>
                          {currentPage} / {totalPages}
                        </span>
                        <Button
                          variant="outline"
                          aria-label="Next page"
                          disabled={currentPage === totalPages}
                          onClick={() => setPage(currentPage + 1)}
                        >
                          <ChevronRight size={16} />
                        </Button>
                      </div>
                    </div>
                  )}
                </>
              )}
            </>
          )}
          <footer className="library-footer">
            <span>
              <LockKeyhole size={13} /> Your catalogue stays encrypted when
              stored.
            </span>
            <span>
              Last updated:{' '}
              {new Date(data.updatedAt).toLocaleDateString('en-AU')}
            </span>
          </footer>
        </div>
      </SidebarInset>
      <Dialog
        open={!!editing}
        onOpenChange={(open) => {
          if (!open && !busy) setEditing(null);
        }}
      >
        {editing && (
          <DialogContent className="lecture-dialog">
            <LectureEditor
              key={editing.id}
              lecture={editing}
              busy={busy}
              onSave={saveLecture}
            />
          </DialogContent>
        )}
      </Dialog>
      <Dialog
        open={settings}
        onOpenChange={(open) => {
          if (!busy) {
            setSettings(open);
            if (!open) setConfig((c) => ({ ...c, token: '' }));
          }
        }}
      >
        <DialogContent className="settings-dialog">
          <DialogTitle>Library settings</DialogTitle>
          <DialogDescription>
            Save your edits across devices and keep an encrypted backup.
          </DialogDescription>
          <section className="settings-section">
            <h3>
              <Download size={17} /> Encrypted backups
            </h3>
            <p>
              Backups include lectures, tags, links, notes, learning progress
              and watch history. The same library password unlocks them.
            </p>
            <div className="button-row">
              <Button variant="outline" disabled={busy} onClick={exportBackup}>
                <Download size={16} /> Export backup
              </Button>
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => fileInput.current?.click()}
              >
                <FolderOpen size={16} /> Import & merge
              </Button>
            </div>
            <input
              ref={fileInput}
              type="file"
              accept=".json"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void importBackup(f);
              }}
            />
          </section>
          <section className="settings-section">
            <h3>
              <CloudUpload size={17} /> Save to GitHub
            </h3>
            <p>
              Edits are saved in this browser first. Publish them here to update
              the library for everyone with the password.
            </p>
            <div className="form-grid">
              <div>
                <label htmlFor="repo">Repository</label>
                <Input
                  id="repo"
                  value={config.repo}
                  onChange={(e) =>
                    setConfig({ ...config, repo: e.target.value })
                  }
                />
              </div>
              <div>
                <label htmlFor="branch">Branch</label>
                <Input
                  id="branch"
                  value={config.branch}
                  onChange={(e) =>
                    setConfig({ ...config, branch: e.target.value })
                  }
                />
              </div>
            </div>
            <label htmlFor="token">GitHub access token</label>
            <Input
              id="token"
              type="password"
              autoComplete="off"
              value={config.token}
              onChange={(e) => setConfig({ ...config, token: e.target.value })}
            />
            <p className="field-help">
              Use a fine-grained token for this repository with Contents: read
              and write. It stays only while this panel is open. Sharing the
              library password allows reading; publishing also requires
              repository access.
            </p>
            {settingsError && (
              <div className="error" role="alert">
                {settingsError}
              </div>
            )}
            <div className="button-row">
              <Button
                className="primary-btn"
                disabled={busy || !config.token || !dirty}
                onClick={publish}
              >
                <CloudUpload size={16} />
                {busy ? 'Working…' : 'Publish changes'}
              </Button>
              <Button
                variant="outline"
                disabled={busy || !config.token}
                onClick={loadLatest}
              >
                Load & merge latest
              </Button>
            </div>
            <p className="field-help">
              Merging keeps the newer version of each lecture. Export a backup
              first if two people have edited the same lecture.
            </p>
          </section>
          <section className="settings-section">
            <h3>
              <ShieldCheck size={17} /> Sharing your library
            </h3>
            <p>
              Share the site address and send the password separately. Everyone
              with the password can read the catalogue and its YouTube links.
              Video access still depends on each video’s YouTube settings.
            </p>
            <p className="field-help">
              Source files and textbooks are not uploaded by this site. Use the
              local rescan tool to add newly downloaded lectures.
            </p>
          </section>
        </DialogContent>
      </Dialog>
    </SidebarProvider>
  );
}
