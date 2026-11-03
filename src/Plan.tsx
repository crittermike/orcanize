import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { navigate } from './router';
import { usePlan, type ConnState, type PasswordError } from './usePlan';
import {
  CapacityBars,
  DEFAULT_BUFFERS,
  DescopedDrawer,
  PrioritizationTable,
  QuarterModal,
  ensureQuarter,
  exportPlanMarkdown,
} from './Capacity';
import { deriveCapacity } from './capacityShared';
import { ColorPopover, ProjectEditModal } from './ProjectModal';
import { LoadError, OfflineBanner } from './ConnectionStatus';
import { useDoneProjects, useReleaseForecasts } from './releaseForecasts';
import {
  milestoneLabel,
  milestoneOf,
  syncGitHubMilestones,
  releasesByWeek as groupReleasesByWeek,
  removeMilestone as removeMilestoneFromState,
  sameSlot,
  setAssignmentMilestone as setAssignmentMilestoneInState,
  type ScheduledRelease,
} from './milestones';
import type { Assignment, Milestone, Project } from './types';
import type { TargetStatus } from './scope';
import { UndoToast } from './Toast';
import { canUndoToast, type UndoToast as UndoToastState } from './undoToast';
import { layoutRuns, type PersonLanes, type RunLayout, type RunSlot } from './runs';
import { currentWeekId as findCurrentWeekId } from './weeks';

type ID = string;

type Person = { id: ID; name: string };
type Iteration = { id: ID; startDate: string; goal?: string };

type Buffer = { id: ID; label: string; pct: number; note?: string };
type Quarter = {
  engineers: number;
  engineersNote?: string;
  weeksInQuarter: number;
  firstResponderWeeks: number;
  weeksPerEM: number;
  buffers: Buffer[];
};

type State = {
  title: string;
  people: Person[];
  projects: Project[];
  iterations: Iteration[];
  assignments: Assignment[];
  weekNotes?: Record<string, string>;
  quarter?: Quarter;
};

const PANEL_KEY = 'gantt-maker-panel-v1';
const TRANSPOSED_KEY = 'gantt-maker-transposed-v1';
const COLLAPSED_ITERATIONS_KEY = 'gantt-maker-collapsed-iterations-v1';
const DARK_MODE_KEY = 'gantt-maker-dark-v1';

/** Soft, characterful palette — paired bg + ink colors for legible chips.
 *  darkBg is the dark-mode equivalent (saturated mid-tone), paired with
 *  light text. Hand-picked so each color stays clearly distinct on a
 *  dark background. */
const PALETTE = [
  { bg: '#fecaca', ink: '#7f1d1d', darkBg: '#7f1d1d' }, // rose
  { bg: '#fed7aa', ink: '#7c2d12', darkBg: '#9a3412' }, // orange
  { bg: '#fef3c7', ink: '#713f12', darkBg: '#854d0e' }, // amber
  { bg: '#d9f99d', ink: '#365314', darkBg: '#4d7c0f' }, // lime
  { bg: '#bbf7d0', ink: '#14532d', darkBg: '#166534' }, // green
  { bg: '#a5f3fc', ink: '#155e75', darkBg: '#155e75' }, // cyan
  { bg: '#bfdbfe', ink: '#1e3a8a', darkBg: '#1e40af' }, // blue
  { bg: '#ddd6fe', ink: '#4c1d95', darkBg: '#5b21b6' }, // violet
  { bg: '#fbcfe8', ink: '#831843', darkBg: '#9d174d' }, // pink
  { bg: '#e2e8f0', ink: '#1e293b', darkBg: '#475569' }, // slate
];
const COLORS = PALETTE.map(p => p.bg);

/** Find a sensible ink (text) color for a given chip bg. */
function inkFor(bg: string): string {
  const m = PALETTE.find(p => p.bg.toLowerCase() === bg.toLowerCase());
  return m ? m.ink : '#1e293b';
}

/** Look up the dark-mode equivalent for a chip color; falls back to the
 *  original if it isn't a known palette color. */
function darkBgFor(bg: string): string {
  const m = PALETTE.find(p => p.bg.toLowerCase() === bg.toLowerCase());
  return m ? m.darkBg : bg;
}

const uid = () => Math.random().toString(36).slice(2, 10);

/** Format an EM number for display, to one decimal (e.g. 3, 1.5, 2.1) */
const fmtWk = (n: number): string => `${Math.round(n * 10) / 10}`;

/* ---------- PTO sentinel ----------
 * PTO is an assignment kind that isn't a project. We model it by reserving a
 * fixed "project id" so it flows through the same Assignment record without
 * touching state.projects (so it never shows up in the projects table or
 * planned-eng-weeks counts).
 */
const PTO_ID: ID = '__pto__';
const PTO_PROJECT: Project = {
  id: PTO_ID,
  name: 'PTO',
  color: '#e2e8f0',
  driId: null,
};
const isPto = (id: ID) => id === PTO_ID;

/* ---------- First Responder sentinel ----------
 * Like PTO: a person-week reserved for on-call/first-responder duty rather
 * than project work. Capacity already deducts `quarter.firstResponderWeeks`,
 * so FR assignments are excluded from `plannedByProject` to avoid
 * double-counting (see capacityShared.tsx).
 */
const FR_ID: ID = '__fr__';
const FR_PROJECT: Project = {
  id: FR_ID,
  name: 'First Responder',
  color: '#fef3c7',
  driId: null,
};
const isFR = (id: ID) => id === FR_ID;

/* ---------- Unavailable sentinel ----------
 * Like PTO but means the person isn't on the team yet (or has left).
 * Visually distinct: solid grey, "N/A" label.
 */
const UNAVAILABLE_ID: ID = '__unavailable__';
const UNAVAILABLE_PROJECT: Project = {
  id: UNAVAILABLE_ID,
  name: 'N/A',
  color: '#94a3b8',
  driId: null,
};
const isUnavailable = (id: ID) => id === UNAVAILABLE_ID;
const isSentinel = (id: ID) => isPto(id) || isFR(id) || isUnavailable(id);

const lookupProject = (
  projectsById: Record<ID, Project>,
  id: ID,
): Project | undefined =>
  isPto(id)
    ? PTO_PROJECT
    : isFR(id)
    ? FR_PROJECT
    : isUnavailable(id)
    ? UNAVAILABLE_PROJECT
    : projectsById[id];

/* ---------- date helpers ---------- */
const parseISODate = (s: string) => {
  const [y, m, d] = s.split('-').map(Number);
  const date = new Date(0);
  date.setFullYear(y, m - 1, d);
  date.setHours(0, 0, 0, 0);
  return date;
};
const toISODate = (d: Date) =>
  `${String(d.getFullYear()).padStart(4, '0')}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const addDays = (d: Date, n: number) => {
  const date = new Date(d);
  date.setDate(date.getDate() + n);
  return date;
};
const mondayOf = (d: Date) => {
  const day = d.getDay();
  return addDays(d, day === 0 ? -6 : 1 - day);
};
const weekLabel = (monday: Date) => {
  const fri = addDays(monday, 4);
  const m1 = monday.toLocaleString('en-US', { month: 'short' });
  const m2 = fri.toLocaleString('en-US', { month: 'short' });
  return m1 === m2
    ? `${m1} ${monday.getDate()}–${fri.getDate()}`
    : `${m1} ${monday.getDate()}–${m2} ${fri.getDate()}`;
};

type IterationTone = 'past' | 'current' | 'future';

const startOfToday = () => {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return today;
};

const iterationTone = (iter: Iteration, today: Date): IterationTone => {
  const start = parseISODate(iter.startDate);
  const end = addDays(start, 14);
  if (today >= start && today < end) return 'current';
  if (today >= end) return 'past';
  return 'future';
};

const readCollapsedIterationIds = (slug: string): Set<ID> => {
  try {
    const raw = localStorage.getItem(COLLAPSED_ITERATIONS_KEY);
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return new Set();
    const ids = (parsed as Record<string, unknown>)[slug];
    if (!Array.isArray(ids)) return new Set();
    return new Set(ids.filter((id): id is ID => typeof id === 'string'));
  } catch {
    return new Set();
  }
};

const hasStoredCollapsedIds = (slug: string): boolean => {
  try {
    const raw = localStorage.getItem(COLLAPSED_ITERATIONS_KEY);
    if (!raw) return false;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
    return slug in (parsed as Record<string, unknown>);
  } catch {
    return false;
  }
};

const writeCollapsedIterationIds = (slug: string, ids: ID[]) => {
  try {
    const raw = localStorage.getItem(COLLAPSED_ITERATIONS_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    const bySlug =
      parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : {};
    localStorage.setItem(COLLAPSED_ITERATIONS_KEY, JSON.stringify({ ...bySlug, [slug]: ids }));
  } catch {}
};

type WeekInfo = { id: string; label: string; startDate: string; iterationId: ID; index: 0 | 1 };

const weeksOfIteration = (iter: Iteration): WeekInfo[] => {
  const start = parseISODate(iter.startDate);
  return [0, 1].map(i => ({
    id: `${iter.id}:${i}`,
    label: weekLabel(addDays(start, i * 7)),
    startDate: toISODate(addDays(start, i * 7)),
    iterationId: iter.id,
    index: i as 0 | 1,
  }));
};

const iterationDateRange = (iter: Iteration): string => {
  const start = parseISODate(iter.startDate);
  const end = addDays(start, 11); // Friday of 2nd week
  const m1 = start.toLocaleString('en-US', { month: 'short' });
  const m2 = end.toLocaleString('en-US', { month: 'short' });
  return m1 === m2
    ? `${m1} ${start.getDate()}–${end.getDate()}`
    : `${m1} ${start.getDate()}–${m2} ${end.getDate()}`;
};

type CollapsedAssignmentSummary = { projectId: ID; weeks: number; milestoneIds: ID[] };

const summarizeIterationAssignments = (
  assignments: Assignment[],
  personId: ID,
  iterationId: ID,
): CollapsedAssignmentSummary[] => {
  const byProject = new Map<ID, { weeks: Set<string>; milestoneIds: Set<ID> }>();
  const prefix = `${iterationId}:`;
  for (const a of assignments) {
    if (a.personId !== personId) continue;
    if (!a.weekId.startsWith(prefix)) continue;
    const entry = byProject.get(a.projectId) ?? { weeks: new Set(), milestoneIds: new Set() };
    entry.weeks.add(a.weekId);
    if (a.milestoneId) entry.milestoneIds.add(a.milestoneId);
    byProject.set(a.projectId, entry);
  }
  return Array.from(byProject.entries()).map(([projectId, { weeks, milestoneIds }]) => ({
    projectId,
    weeks: weeks.size,
    milestoneIds: [...milestoneIds],
  }));
};

const collectIterationNotes = (
  weekNotes: Record<string, string> | undefined,
  weeks: WeekInfo[],
): string[] => {
  if (!weekNotes) return [];
  const out: string[] = [];
  for (const w of weeks) {
    const t = (weekNotes[w.id] ?? '').trim();
    if (t) out.push(t);
  }
  return out;
};

/* ---------- seed ---------- */

/* ============================================================ */

export default function Plan({ slug, projectId }: { slug: string; projectId?: string }) {
  const {
    state: liveState,
    setState: setLiveState,
    conn,
    peers,
    passwordRequired,
    planName,
    hasPassword,
    loadFailed,
    retryLoad,
    submitPassword,
    changePassword,
  } = usePlan(slug);

  if (conn === 'missing') {
    return (
      <div className="flex h-screen w-screen items-center justify-center p-6">
        <div className="max-w-md rounded-2xl border border-ink-200 bg-white p-8 text-center shadow-sm">
          <h1 className="text-[20px] font-semibold text-ink-900">Plan not found</h1>
          <p className="mt-2 text-[13px] text-ink-500">
            No plan exists at <span className="font-mono">/{slug}</span>.
          </p>
          <button
            className="mt-5 inline-flex h-9 items-center rounded-lg bg-brand-600 px-4 text-[13px] font-semibold text-[#fff] shadow-sm transition hover:bg-brand-700 active:scale-[0.98]"
            onClick={() => navigate('/')}
          >
            ← Back to plans
          </button>
        </div>
      </div>
    );
  }

  if (passwordRequired) {
    return <UnlockPrompt slug={slug} name={planName} onSubmit={submitPassword} />;
  }

  if (loadFailed && !liveState) return <LoadError onRetry={retryLoad} />;

  if (!liveState) {
    return (
      <div className="flex h-screen w-screen items-center justify-center text-[13px] text-ink-500">
        Loading…
      </div>
    );
  }

  return (
    <>
      <PlanView
        slug={slug}
        initialProjectId={projectId}
        state={liveState}
        setState={setLiveState}
        conn={conn}
        peers={peers}
        hasPassword={hasPassword}
        changePassword={changePassword}
      />
      <OfflineBanner conn={conn} />
    </>
  );
}

function UnlockPrompt({
  slug,
  name,
  onSubmit,
}: {
  slug: string;
  name: string | null;
  onSubmit: (pw: string) => Promise<{ ok: true } | { ok: false; error: PasswordError; message?: string }>;
}) {
  const [pw, setPw] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!pw || submitting) return;
    setSubmitting(true);
    setErr(null);
    const result = await onSubmit(pw);
    setSubmitting(false);
    if (!result.ok) {
      if (result.error === 'wrong_password') setErr('Wrong password.');
      else if (result.error === 'too_many_attempts') setErr(result.message ?? 'Too many attempts. Wait a minute and try again.');
      else setErr(result.message ?? 'Something went wrong. Try again.');
      setPw('');
    }
  };

  return (
    <div className="flex h-screen w-screen items-center justify-center bg-ink-50 p-6">
      <form
        onSubmit={submit}
        className="w-full max-w-sm rounded-2xl border border-ink-200 bg-white p-8 shadow-xl shadow-ink-900/10"
      >
        <div className="mb-1 flex items-center gap-2 text-ink-500">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
            <rect x="3" y="7" width="10" height="7" rx="1.5" stroke="currentColor" strokeWidth="1.4" />
            <path d="M5 7V5a3 3 0 1 1 6 0v2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          </svg>
          <span className="text-[11px] font-semibold uppercase tracking-[0.08em]">Password required</span>
        </div>
        <h1 className="text-[18px] font-semibold text-ink-900">
          {name || slug}
        </h1>
        <p className="mt-1 text-[12.5px] text-ink-500">
          This plan is password-protected. Enter the password to view and edit.
        </p>

        <label className="mt-5 block">
          <span className="sr-only">Password</span>
          <input
            type="password"
            autoFocus
            value={pw}
            onChange={e => setPw(e.target.value)}
            placeholder="Password"
            className="block w-full rounded-lg border border-ink-300 bg-white px-3 py-2 text-[13px] text-ink-900 outline-none transition focus:border-brand-400 focus:ring-2 focus:ring-brand-200"
          />
        </label>
        {err && (
          <div className="mt-2 rounded-md bg-rose-50 px-2.5 py-1.5 text-[12px] text-rose-700">{err}</div>
        )}

        <button
          type="submit"
          disabled={submitting || !pw}
          className="mt-4 inline-flex h-9 w-full items-center justify-center rounded-lg bg-brand-600 px-4 text-[13px] font-semibold text-[#fff] shadow-sm transition hover:bg-brand-700 active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-60"
        >
          {submitting ? 'Unlocking…' : 'Unlock'}
        </button>
        <button
          type="button"
          onClick={() => navigate('/')}
          className="mt-2 inline-flex h-8 w-full items-center justify-center rounded-lg text-[12px] font-medium text-ink-500 transition hover:bg-ink-100 hover:text-ink-700"
        >
          ← Back to plans
        </button>
      </form>
    </div>
  );
}

function sortByPriority(active: Project[], allProjects: Project[]): Project[] {
  const order = new Map(allProjects.map((p, i) => [p.id, i]));
  return [...active].sort((a, b) => {
    const pa = a.priority ?? Number.MAX_SAFE_INTEGER;
    const pb = b.priority ?? Number.MAX_SAFE_INTEGER;
    if (pa !== pb) return pa - pb;
    // Tiebreak by original index so legacy projects keep their order.
    return (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0);
  });
}

function PlanView({
  slug,
  initialProjectId,
  state,
  setState,
  conn,
  peers,
  hasPassword,
  changePassword,
}: {
  slug: string;
  /** Project to open on load, from a /<slug>/p/<projectId> link. */
  initialProjectId?: ID;
  state: State;
  setState: (updater: (s: State) => State) => void;
  conn: ConnState;
  peers: number;
  hasPassword: boolean;
  changePassword: (args: { currentPassword?: string; newPassword: string | null }) => Promise<
    { ok: true } | { ok: false; error: PasswordError; message?: string }
  >;
}) {
  // Set page title to plan name
  useEffect(() => {
    document.title = state.title ? `${state.title} — Allocation Planner` : 'Allocation Planner';
    return () => { document.title = 'Allocation Planner'; };
  }, [state.title]);

  const projectsById = useMemo(
    () => Object.fromEntries(state.projects.map(p => [p.id, p])),
    [state.projects],
  );
  const peopleById = useMemo(
    () => Object.fromEntries(state.people.map(p => [p.id, p])),
    [state.people],
  );
  const allWeeks = useMemo(
    () => state.iterations.flatMap(weeksOfIteration),
    [state.iterations],
  );
  const releaseForecasts = useReleaseForecasts(slug, state.projects);
  const doneProjectIds = useDoneProjects(slug, state.projects);
  const releasesByWeek = useMemo(
    () => groupReleasesByWeek(state.projects, allWeeks, releaseForecasts),
    [state.projects, allWeeks, releaseForecasts],
  );
  const iterationToneById = useMemo(() => {
    const today = startOfToday();
    const tones: Record<ID, IterationTone> = {};
    for (const iter of state.iterations) {
      tones[iter.id] = iterationTone(iter, today);
    }
    return tones;
  }, [state.iterations]);
  const currentIterationId = useMemo<ID | null>(
    () => state.iterations.find(iter => iterationToneById[iter.id] === 'current')?.id ?? null,
    [iterationToneById, state.iterations],
  );
  const currentWeekId = useMemo(
    () => findCurrentWeekId(allWeeks, toISODate(startOfToday())),
    [allWeeks],
  );
  const cap = useMemo(() => deriveCapacity(state), [state]);
  const plannedByProject = cap.plannedByProject;

  /* ---------- undo / redo ---------- */
  const UNDO_CAP = 50;
  const stateRef = useRef(state);
  stateRef.current = state;
  const undoStackRef = useRef<State[]>([]);
  const redoStackRef = useRef<State[]>([]);
  const [undoLen, setUndoLen] = useState(0);
  const [redoLen, setRedoLen] = useState(0);

  // Save current state as an undo checkpoint
  const pushUndo = useCallback(() => {
    const stack = undoStackRef.current;
    stack.push(stateRef.current);
    if (stack.length > UNDO_CAP) stack.splice(0, stack.length - UNDO_CAP);
    redoStackRef.current = [];
    setUndoLen(stack.length);
    setRedoLen(0);
  }, []);

  const undo = useCallback(() => {
    const stack = undoStackRef.current;
    if (stack.length === 0) return;
    const prev = stack.pop()!;
    redoStackRef.current.push(stateRef.current);
    setState(() => prev);
    setUndoLen(stack.length);
    setRedoLen(redoStackRef.current.length);
  }, [setState]);

  const redo = useCallback(() => {
    const stack = redoStackRef.current;
    if (stack.length === 0) return;
    const next = stack.pop()!;
    undoStackRef.current.push(stateRef.current);
    setState(() => next);
    setUndoLen(undoStackRef.current.length);
    setRedoLen(stack.length);
  }, [setState]);

  // Destructive actions apply immediately; this toast offers to undo the latest one.
  const [undoToast, setUndoToast] = useState<UndoToastState<State> | null>(null);
  const undoToastIdRef = useRef(0);
  const showUndoToast = (message: string) => {
    const checkpoint = undoStackRef.current[undoStackRef.current.length - 1];
    setUndoToast({ id: ++undoToastIdRef.current, message, checkpoint });
  };
  const dismissUndoToast = useCallback(() => setUndoToast(null), []);
  const undoFromToast = () => {
    if (canUndoToast(undoStackRef.current, undoToast)) undo();
    setUndoToast(null);
  };

  // For text fields: capture snapshot on focus, push to undo on blur if changed
  const textSnapshotRef = useRef<State | null>(null);
  const onTextFocus = useCallback(() => {
    textSnapshotRef.current = stateRef.current;
  }, []);
  const onTextBlur = useCallback(() => {
    const snap = textSnapshotRef.current;
    if (snap && snap !== stateRef.current) {
      undoStackRef.current.push(snap);
      if (undoStackRef.current.length > UNDO_CAP) undoStackRef.current.splice(0, undoStackRef.current.length - UNDO_CAP);
      redoStackRef.current = [];
      setUndoLen(undoStackRef.current.length);
      setRedoLen(0);
    }
    textSnapshotRef.current = null;
  }, []);

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
        e.preventDefault();
        undo();
      } else if ((e.ctrlKey || e.metaKey) && e.key === 'z' && e.shiftKey) {
        e.preventDefault();
        redo();
      } else if ((e.ctrlKey || e.metaKey) && e.key === 'y') {
        e.preventDefault();
        redo();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [undo, redo]);

  /* mutations */
  // Text mutations — undo captured via onTextFocus / onTextBlur
  const setTitle = (title: string) => setState(s => ({ ...s, title }));
  const renamePerson = (id: ID, name: string) =>
    setState(s => ({ ...s, people: s.people.map(p => (p.id === id ? { ...p, name } : p)) }));
  const updateProject = (id: ID, patch: Partial<Project>) => {
    if ('releaseDate' in patch && stateRef.current.projects.find(p => p.id === id)?.releaseDate !== patch.releaseDate) {
      pushUndo();
    }
    setState(s => ({
      ...s,
      projects: s.projects.map(p => (p.id === id ? { ...p, ...patch } : p)),
    }));
  };
  const updateMilestone = (projectId: ID, milestoneId: ID, patch: Partial<Omit<Milestone, 'id'>>) => {
    const current = milestoneOf(stateRef.current.projects.find(p => p.id === projectId), milestoneId);
    if (!current) return;
    if ('releaseDate' in patch && current.releaseDate !== patch.releaseDate) pushUndo();
    setState(s => ({
      ...s,
      projects: s.projects.map(p => (p.id === projectId
        ? { ...p, milestones: p.milestones?.map(m => (m.id === milestoneId ? { ...m, ...patch } : m)) }
        : p)),
    }));
  };
  const setWeekNote = (weekId: string, text: string) =>
    setState(s => {
      const next = { ...(s.weekNotes ?? {}) };
      const trimmed = text.trim();
      if (trimmed === '') delete next[weekId];
      else next[weekId] = text;
      return { ...s, weekNotes: next };
    });

  // Discrete mutations — push undo before each
  const addPerson = (name = 'New person') => {
    pushUndo();
    setState(s => ({ ...s, people: [...s.people, { id: uid(), name }] }));
  };
  const movePerson = (id: ID, dir: -1 | 1) => {
    pushUndo();
    setState(s => {
      const idx = s.people.findIndex(p => p.id === id);
      if (idx === -1) return s;
      const newIdx = idx + dir;
      if (newIdx < 0 || newIdx >= s.people.length) return s;
      const next = [...s.people];
      [next[idx], next[newIdx]] = [next[newIdx], next[idx]];
      return { ...s, people: next };
    });
  };
  const removePerson = (id: ID) => {
    const person = stateRef.current.people.find(p => p.id === id);
    pushUndo();
    showUndoToast(`Removed ${person?.name ?? 'person'}`);
    setState(s => ({
      ...s,
      people: s.people.filter(p => p.id !== id),
      assignments: s.assignments.filter(a => a.personId !== id),
    }));
  };
  const addProject = (): ID => {
    pushUndo();
    const id = uid();
    setState(s => {
      const maxPriority = s.projects
        .filter(p => !p.descoped)
        .reduce((m, p) => Math.max(m, p.priority ?? 0), 0);
      return {
        ...s,
        projects: [
          ...s.projects,
          { id, name: 'New project', color: COLORS[s.projects.length % COLORS.length], driId: null, priority: maxPriority + 1 },
        ],
      };
    });
    return id;
  };
  const removeProject = (id: ID) => {
    const project = stateRef.current.projects.find(p => p.id === id);
    pushUndo();
    showUndoToast(`Deleted ${project?.name ?? 'project'}`);
    setState(s => ({
      ...s,
      projects: s.projects.filter(p => p.id !== id),
      assignments: s.assignments.filter(a => a.projectId !== id),
    }));
  };
  const addMilestones = (projectId: ID, items: Omit<Milestone, 'id'>[]) => {
    if (items.length === 0) return;
    pushUndo();
    setState(s => ({
      ...s,
      projects: s.projects.map(p => (p.id === projectId
        ? { ...p, milestones: [...(p.milestones ?? []), ...items.map(item => ({ ...item, id: uid() }))] }
        : p)),
    }));
  };
  // Runs whenever scope tracking loads the project's epic. No undo entry: it mirrors GitHub.
  const syncMilestones = useCallback((projectId: ID, found: { name: string; url: string }[]) => {
    setState(s => {
      const project = s.projects.find(p => p.id === projectId);
      if (!project) return s;
      const milestones = syncGitHubMilestones(project.milestones, found, uid);
      if (milestones === project.milestones) return s;
      return { ...s, projects: s.projects.map(p => (p.id === projectId ? { ...p, milestones } : p)) };
    });
  }, [setState]);
  const removeMilestone = (projectId: ID, milestoneId: ID) => {
    const milestone = milestoneOf(stateRef.current.projects.find(p => p.id === projectId), milestoneId);
    pushUndo();
    showUndoToast(`Removed ${milestone ? milestoneLabel(milestone) : 'milestone'}`);
    setState(s => removeMilestoneFromState(s, projectId, milestoneId));
  };
  const setAssignmentMilestone = (assignmentId: ID, milestoneId: ID | undefined) => {
    pushUndo();
    setState(s => setAssignmentMilestoneInState(s, assignmentId, milestoneId));
  };
  const descopeProject = (id: ID) => {
    const proj = state.projects.find(p => p.id === id);
    if (!proj) return;
    pushUndo();
    showUndoToast(`Descoped ${proj.name}`);
    setState(s => ({
      ...s,
      projects: s.projects.map(p => (p.id === id ? { ...p, descoped: true } : p)),
    }));
  };
  const restoreProject = (id: ID) => {
    pushUndo();
    setState(s => ({
      ...s,
      projects: s.projects.map(p => (p.id === id ? { ...p, descoped: false } : p)),
    }));
  };
  const moveProjectToIndex = (id: ID, targetIndex: number) => {
    pushUndo();
    setState(s => {
      const active = sortByPriority(s.projects.filter(p => !p.descoped), s.projects);
      const fromIdx = active.findIndex(p => p.id === id);
      if (fromIdx === -1) return s;
      let toIdx = Math.max(0, Math.min(active.length - 1, targetIndex));
      if (fromIdx === toIdx) return s;
      const reordered = [...active];
      const [moved] = reordered.splice(fromIdx, 1);
      reordered.splice(toIdx, 0, moved);
      const renumbered = reordered.map((p, i) => ({ ...p, priority: i + 1 }));
      const byId = new Map(renumbered.map(p => [p.id, p]));
      return {
        ...s,
        projects: s.projects.map(p => byId.get(p.id) ?? p),
      };
    });
  };
  const updateQuarter = (patch: Partial<NonNullable<State['quarter']>>) => {
    pushUndo();
    setState(s => {
      const current = ensureQuarter(s);
      return { ...s, quarter: { ...current, ...patch } };
    });
  };
  const addBuffer = () => {
    pushUndo();
    setState(s => {
      const current = ensureQuarter(s);
      return {
        ...s,
        quarter: {
          ...current,
          buffers: [...current.buffers, { id: uid(), label: 'Buffer', pct: 5 }],
        },
      };
    });
  };
  const updateBuffer = (bufferId: ID, patch: Partial<{ label: string; pct: number; note?: string }>) => {
    pushUndo();
    setState(s => {
      const current = ensureQuarter(s);
      return {
        ...s,
        quarter: {
          ...current,
          buffers: current.buffers.map(b => (b.id === bufferId ? { ...b, ...patch } : b)),
        },
      };
    });
  };
  const removeBuffer = (bufferId: ID) => {
    pushUndo();
    setState(s => {
      const current = ensureQuarter(s);
      return {
        ...s,
        quarter: { ...current, buffers: current.buffers.filter(b => b.id !== bufferId) },
      };
    });
  };
  const installDefaultBuffers = () => {
    pushUndo();
    setState(s => {
      const current = ensureQuarter(s);
      return {
        ...s,
        quarter: { ...current, buffers: DEFAULT_BUFFERS.map(b => ({ ...b, id: uid() })) },
      };
    });
  };
  const addIteration = () => {
    pushUndo();
    setState(s => {
      const nextStart =
        s.iterations.length === 0
          ? mondayOf(new Date())
          : addDays(parseISODate(s.iterations[s.iterations.length - 1].startDate), 14);
      const next = [...s.iterations, { id: uid(), startDate: toISODate(nextStart) }];
      next.sort((a, b) => a.startDate.localeCompare(b.startDate));
      return { ...s, iterations: next };
    });
  };
  const addPastIteration = () => {
    pushUndo();
    setState(s => {
      const prevStart =
        s.iterations.length === 0
          ? mondayOf(new Date())
          : addDays(parseISODate(s.iterations[0].startDate), -14);
      const next = [{ id: uid(), startDate: toISODate(prevStart) }, ...s.iterations];
      next.sort((a, b) => a.startDate.localeCompare(b.startDate));
      return { ...s, iterations: next };
    });
  };
  const setIterationStart = (id: ID, isoDate: string) => {
    pushUndo();
    setState(s => {
      const d = parseISODate(isoDate);
      if (isNaN(d.getTime())) return s;
      const anchor = mondayOf(d);
      const anchorIdx = s.iterations.findIndex(i => i.id === id);
      if (anchorIdx === -1) return s;
      const next = s.iterations.map((iter, idx) => ({
        ...iter,
        startDate: toISODate(addDays(anchor, (idx - anchorIdx) * 14)),
      }));
      return { ...s, iterations: next };
    });
  };
  const removeIteration = (iterationId: ID) => {
    pushUndo();
    showUndoToast('Removed iteration');
    setState(s => {
      const weekIds = new Set([`${iterationId}:0`, `${iterationId}:1`]);
      return {
        ...s,
        iterations: s.iterations.filter(i => i.id !== iterationId),
        assignments: s.assignments.filter(a => !weekIds.has(a.weekId)),
      };
    });
  };
  const setIterationGoal = (iterationId: ID, goal: string) => {
    pushUndo();
    setState(s => ({
      ...s,
      iterations: s.iterations.map(i =>
        i.id === iterationId
          ? { ...i, goal: goal.trim() ? goal.trim() : undefined }
          : i,
      ),
    }));
  };
  const duplicateIteration = (sourceId: ID) => {
    pushUndo();
    setState(s => {
      const src = s.iterations.find(i => i.id === sourceId);
      if (!src) return s;
      const lastStart =
        s.iterations.length === 0
          ? mondayOf(new Date())
          : addDays(parseISODate(s.iterations[s.iterations.length - 1].startDate), 14);
      const newId = uid();
      const newIter: Iteration = {
        id: newId,
        startDate: toISODate(lastStart),
        goal: src.goal,
      };
      const srcW0 = `${sourceId}:0`;
      const srcW1 = `${sourceId}:1`;
      const copiedAssignments = s.assignments
        .filter(a => a.weekId === srcW0 || a.weekId === srcW1)
        .map(a => ({
          ...a,
          id: uid(),
          weekId: a.weekId === srcW0 ? `${newId}:0` : `${newId}:1`,
        }));
      const nextWeekNotes = { ...(s.weekNotes ?? {}) };
      const srcNote0 = s.weekNotes?.[srcW0];
      const srcNote1 = s.weekNotes?.[srcW1];
      if (srcNote0) nextWeekNotes[`${newId}:0`] = srcNote0;
      if (srcNote1) nextWeekNotes[`${newId}:1`] = srcNote1;
      return {
        ...s,
        iterations: [...s.iterations, newIter],
        assignments: [...s.assignments, ...copiedAssignments],
        weekNotes: nextWeekNotes,
      };
    });
  };
  const addAssignment = (personId: ID, weekId: string, projectId: ID, milestoneId?: ID) => {
    pushUndo();
    setState(s => {
      const valid = milestoneOf(s.projects.find(p => p.id === projectId), milestoneId) ? milestoneId : undefined;
      const next: Assignment = valid
        ? { id: uid(), personId, weekId, projectId, milestoneId: valid }
        : { id: uid(), personId, weekId, projectId };
      if (s.assignments.some(a => sameSlot(a, next))) return s;
      return { ...s, assignments: [...s.assignments, next] };
    });
  };
  const moveAssignment = (assignmentId: ID, personId: ID, weekId: string) => {
    pushUndo();
    setState(s => {
      const a = s.assignments.find(x => x.id === assignmentId);
      if (!a) return s;
      const dup = s.assignments.some(
        x => x.id !== assignmentId && sameSlot(x, { ...a, personId, weekId }),
      );
      if (dup) return { ...s, assignments: s.assignments.filter(x => x.id !== assignmentId) };
      return {
        ...s,
        assignments: s.assignments.map(x => (x.id === assignmentId ? { ...x, personId, weekId } : x)),
      };
    });
  };
  const removeAssignment = (id: ID) => {
    pushUndo();
    setState(s => ({ ...s, assignments: s.assignments.filter(a => a.id !== id) }));
  };
  const clearAssignments = () => {
    pushUndo();
    showUndoToast('Cleared chart');
    setState(s => ({ ...s, assignments: [] }));
  };

  /* Auto-scroll the chart so the current iteration is the first one visible.
   * Runs when the current iteration changes (e.g. after the plan loads from
   * the server, or after editing iteration dates). Past iterations remain
   * accessible by scrolling left. */
  const chartScrollRef = useRef<HTMLDivElement | null>(null);
  const lastScrolledIterRef = useRef<ID | null>(null);
  const [collapsedIterationIds, setCollapsedIterationIds] = useState<Set<ID>>(
    () => readCollapsedIterationIds(slug),
  );
  const didAutoCollapse = useRef(false);
  // Set while an auto-collapse is about to change the layout, so the initial scroll waits for it.
  const autoCollapsePending = useRef(false);

  // On first load, auto-collapse past iterations if no stored preference exists
  useEffect(() => {
    if (didAutoCollapse.current) return;
    if (state.iterations.length === 0) return;
    if (hasStoredCollapsedIds(slug)) { didAutoCollapse.current = true; return; }
    didAutoCollapse.current = true;
    const today = startOfToday();
    const pastIds = state.iterations
      .filter(iter => iterationTone(iter, today) === 'past')
      .map(iter => iter.id);
    if (pastIds.length > 0) {
      autoCollapsePending.current = true;
      setCollapsedIterationIds(prev => {
        const next = new Set(prev);
        for (const id of pastIds) next.add(id);
        return next;
      });
    }
  }, [slug, state.iterations]);

  useEffect(() => {
    const validIds = new Set(state.iterations.map(iter => iter.id));
    setCollapsedIterationIds(prev => {
      let changed = false;
      const next = new Set<ID>();
      for (const id of prev) {
        if (validIds.has(id)) next.add(id);
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [state.iterations]);

  useEffect(() => {
    const validIds = new Set(state.iterations.map(iter => iter.id));
    const ids = [...collapsedIterationIds].filter(id => validIds.has(id));
    writeCollapsedIterationIds(slug, ids);
  }, [slug, collapsedIterationIds, state.iterations]);

  const toggleIterationCollapsed = (id: ID) => {
    lastScrolledIterRef.current = null;
    setCollapsedIterationIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  /* projects panel state */
  const [transposed, setTransposed] = useState<boolean>(() => {
    try {
      const stored = localStorage.getItem(TRANSPOSED_KEY);
      return stored === null ? false : stored === '1';
    } catch {
      return false;
    }
  });
  const [darkMode, setDarkMode] = useState<boolean>(() => {
    try {
      return localStorage.getItem(DARK_MODE_KEY) === '1';
    } catch {
      return false;
    }
  });
  useEffect(() => {
    const root = document.documentElement;
    if (darkMode) root.classList.add('dark');
    else root.classList.remove('dark');
    try { localStorage.setItem(DARK_MODE_KEY, darkMode ? '1' : '0'); } catch {}
  }, [darkMode]);
  const [editingProjectId, setEditingProjectId] = useState<ID | null>(
    () => (initialProjectId && state.projects.some(p => p.id === initialProjectId) ? initialProjectId : null),
  );
  // Keep the address bar pointing at the open project so the link can be shared.
  useEffect(() => {
    const target = editingProjectId ? `/${slug}/p/${editingProjectId}` : `/${slug}`;
    if (window.location.pathname !== target) window.history.replaceState(null, '', target);
  }, [slug, editingProjectId]);
  const [isAddingProject, setIsAddingProject] = useState(false);
  const [highlightedProjectId, setHighlightedProjectId] = useState<ID | null>(null);
  const [passwordDialog, setPasswordDialog] = useState<'set' | 'change' | 'remove' | null>(null);
  const [quarterModalOpen, setQuarterModalOpen] = useState(false);
  // Default to "show what fits" when the quarter is configured — if the user has
  // set up capacity, they probably want to see the over/under-capacity cut line.
  const [showWhatFits, setShowWhatFits] = useState<boolean>(() => !!state.quarter);
  const [copiedMd, setCopiedMd] = useState(false);

  const editProject = (id: ID) => {
    setIsAddingProject(false);
    setEditingProjectId(id);
  };

  const activeInitiatives = useMemo(
    () => sortByPriority(state.projects.filter(p => !p.descoped), state.projects),
    [state.projects],
  );
  const descopedInitiatives = useMemo(
    () => state.projects.filter(p => p.descoped),
    [state.projects],
  );
  const unrankedCount = activeInitiatives.filter(p => p.priority == null).length;
  const fitMarkerIndex = useMemo(() => {
    if (!cap.hasConfiguredQuarter) return -1;
    let cum = 0;
    for (let i = 0; i < activeInitiatives.length; i++) {
      cum += activeInitiatives[i].estimateEM ?? 0;
      if (cum > cap.capacityEM + 0.0001) return i;
    }
    return -1;
  }, [activeInitiatives, cap.capacityEM, cap.hasConfiguredQuarter]);

  const copyMarkdown = useCallback(async () => {
    const md = exportPlanMarkdown(state, cap, activeInitiatives, descopedInitiatives);
    try {
      await navigator.clipboard.writeText(md);
      setCopiedMd(true);
      setTimeout(() => setCopiedMd(false), 1800);
    } catch {
      // Fallback: open prompt with text selected
      window.prompt('Copy plan markdown:', md);
    }
  }, [state, cap, activeInitiatives, descopedInitiatives]);
  useEffect(() => {
    try { localStorage.setItem(TRANSPOSED_KEY, transposed ? '1' : '0'); } catch {}
    // re-trigger auto-scroll on layout swap
    lastScrolledIterRef.current = null;
  }, [transposed]);
  useRunLabelReveal(chartScrollRef, transposed);

  useEffect(() => {
    if (!currentIterationId) return;
    if (lastScrolledIterRef.current === currentIterationId) return;
    if (autoCollapsePending.current) {
      autoCollapsePending.current = false;
      return;
    }
    const scroller = chartScrollRef.current;
    if (!scroller) return;
    const target = scroller.querySelector<HTMLElement>(
      `[data-iter-id="${currentIterationId}"]`,
    );
    if (!target) return;
    // Snap the current iteration's start flush against the sticky header/column.
    const t = target.getBoundingClientRect();
    if (transposed) {
      const header = scroller.querySelector('thead')?.getBoundingClientRect();
      if (!header) return;
      scroller.scrollTo({ top: Math.max(0, scroller.scrollTop + t.top - header.bottom) });
    } else {
      const corner = scroller.querySelector('thead th')?.getBoundingClientRect();
      if (!corner) return;
      scroller.scrollTo({ left: Math.max(0, scroller.scrollLeft + t.left - corner.right) });
    }
    lastScrolledIterRef.current = currentIterationId;
  }, [collapsedIterationIds, currentIterationId, transposed]);

  const [panel, setPanel] = useState<{ collapsed: boolean; height: number }>(() => {
    try {
      const raw = localStorage.getItem(PANEL_KEY);
      if (raw) return JSON.parse(raw);
    } catch {}
    return { collapsed: false, height: 320 };
  });
  useEffect(() => {
    localStorage.setItem(PANEL_KEY, JSON.stringify(panel));
  }, [panel]);

  const onResizeStart = (e: React.MouseEvent) => {
    if (panel.collapsed) return;
    e.preventDefault();
    const startY = e.clientY;
    const startH = panel.height;
    const onMove = (ev: MouseEvent) => {
      const dy = startY - ev.clientY;
      const next = Math.max(160, Math.min(window.innerHeight - 220, startH + dy));
      setPanel(p => ({ ...p, height: next }));
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const editingProject = useMemo(
    () => state.projects.find(p => p.id === editingProjectId) ?? null,
    [state.projects, editingProjectId],
  );
  const assignedByMilestone = useMemo(() => {
    const counts: Record<ID, number> = {};
    for (const a of state.assignments) {
      if (a.projectId === editingProjectId && a.milestoneId) counts[a.milestoneId] = (counts[a.milestoneId] ?? 0) + 1;
    }
    return counts;
  }, [state.assignments, editingProjectId]);

  return (
    <>
    <div className="flex h-screen w-screen flex-col">
      {/* Toolbar */}
      <div className="relative z-30 flex items-center gap-2 border-b border-ink-200/80 bg-white/70 px-4 py-2.5 backdrop-blur-md">
        <button
          onClick={() => navigate('/')}
          className="mr-1 inline-flex h-7 items-center gap-1 rounded-md px-2 text-[12px] font-medium text-ink-500 transition hover:bg-ink-100 hover:text-ink-900"
          title="Back to all plans"
        >
          ← Plans
        </button>
        <input
          className="min-w-0 flex-1 rounded-md border border-transparent bg-transparent px-2.5 py-1.5 text-[14px] font-semibold text-ink-900 outline-none transition hover:bg-ink-100/70 focus:border-ink-300 focus:bg-white focus:ring-2 focus:ring-brand-200"
          value={state.title}
          onChange={e => setTitle(e.target.value)}
          onFocus={onTextFocus}
          onBlur={onTextBlur}
        />
        {copiedMd && (
          <span className="anim-pop-in inline-flex h-6 items-center rounded-full bg-emerald-100 px-2 text-[11px] font-medium text-emerald-700">
            Copied!
          </span>
        )}
        {hasPassword && (
          <button
            type="button"
            onClick={() => setPasswordDialog('change')}
            title="Password-protected — click to change or remove"
            className="inline-flex h-6 items-center gap-1 rounded-md bg-amber-100 px-2 text-[11px] font-medium text-amber-800 transition hover:bg-amber-200"
          >
            <svg width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden>
              <rect x="3" y="7" width="10" height="7" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
              <path d="M5 7V5a3 3 0 1 1 6 0v2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
            Locked
          </button>
        )}
        <Presence conn={conn} peers={peers} />
        <div className="mx-1 h-5 w-px bg-ink-200" aria-hidden />
        <IconToolbarButton disabled={undoLen === 0} onClick={undo} title="Undo (⌘Z)" label="Undo"><IconUndo /></IconToolbarButton>
        <IconToolbarButton disabled={redoLen === 0} onClick={redo} title="Redo (⇧⌘Z)" label="Redo"><IconRedo /></IconToolbarButton>
        <OverflowMenu
          items={[
            { sectionLabel: 'Add' },
            { label: 'Past iteration', icon: <IconArrowLeft />, onClick: addPastIteration, title: 'Add an iteration before the first one' },
            { sectionLabel: 'Plan' },
            {
              label: cap.hasConfiguredQuarter ? 'Quarter setup' : 'Set up quarter',
              icon: cap.hasConfiguredQuarter ? <IconGear /> : <span className="text-amber-500"><IconAlert /></span>,
              onClick: () => setQuarterModalOpen(true),
              title: cap.hasConfiguredQuarter ? 'Edit team size, weeks, buffers' : 'Set up your quarter to enable capacity tracking',
            },
            { label: 'Copy markdown', icon: <IconClipboard />, onClick: copyMarkdown, title: 'Copy a markdown summary of the plan to share with stakeholders' },
            { sectionLabel: 'View' },
            { label: transposed ? 'People as rows' : 'Weeks as rows', icon: <IconSwap />, onClick: () => setTransposed(t => !t), title: transposed ? 'Switch back to people-as-rows view' : 'Swap rows and columns (weeks as rows)' },
            { label: darkMode ? 'Light mode' : 'Dark mode', icon: darkMode ? <IconSun /> : <IconMoon />, onClick: () => setDarkMode(d => !d), title: darkMode ? 'Switch to light mode' : 'Switch to dark mode' },
            { sectionLabel: 'Sharing' },
            hasPassword
              ? { label: 'Change password', icon: <IconLock />, onClick: () => setPasswordDialog('change'), title: 'Change the password required to view this plan' }
              : { label: 'Set password', icon: <IconLock />, onClick: () => setPasswordDialog('set'), title: 'Require a password to view this plan' },
            ...(hasPassword
              ? [{ label: 'Remove password', icon: <IconUnlock />, onClick: () => setPasswordDialog('remove'), title: 'Remove the password from this plan' } as OverflowItem]
              : []),
            { divider: true },
            { label: 'Clear chart', icon: <IconTrash />, onClick: clearAssignments, danger: true, title: 'Remove all assignments' },
          ]}
        />
      </div>

      <div className="flex min-h-0 flex-1 flex-col">
        {/* Chart pane */}
        <div ref={chartScrollRef} className="m-4 mb-6 min-h-0 min-w-0 flex-1 overflow-auto">
          {transposed ? (
            <ChartTransposed
              state={state}
              allWeeks={allWeeks}
              projectsById={projectsById}
              releasesByWeek={releasesByWeek}
              onEditProject={editProject}
              collapsedIterationIds={collapsedIterationIds}
              currentIterationId={currentIterationId}
              currentWeekId={currentWeekId}
              iterationToneById={iterationToneById}
              highlightedProjectId={highlightedProjectId}
              toggleIterationCollapsed={toggleIterationCollapsed}
              renamePerson={renamePerson}
              movePerson={movePerson}
              removePerson={removePerson}
              addPerson={addPerson}
              addIteration={addIteration}
              removeIteration={removeIteration}
              setIterationStart={setIterationStart}
              setIterationGoal={setIterationGoal}
              duplicateIteration={duplicateIteration}
              addAssignment={addAssignment}
              moveAssignment={moveAssignment}
              setAssignmentMilestone={setAssignmentMilestone}
              removeAssignment={removeAssignment}
              setWeekNote={setWeekNote}
              onTextFocus={onTextFocus}
              onTextBlur={onTextBlur}
            />
          ) : (
            <Chart
              state={state}
              allWeeks={allWeeks}
              projectsById={projectsById}
              releasesByWeek={releasesByWeek}
              onEditProject={editProject}
              collapsedIterationIds={collapsedIterationIds}
              currentIterationId={currentIterationId}
              currentWeekId={currentWeekId}
              iterationToneById={iterationToneById}
              highlightedProjectId={highlightedProjectId}
              toggleIterationCollapsed={toggleIterationCollapsed}
              renamePerson={renamePerson}
              movePerson={movePerson}
              removePerson={removePerson}
              addPerson={addPerson}
              addIteration={addIteration}
              removeIteration={removeIteration}
              setIterationStart={setIterationStart}
              setIterationGoal={setIterationGoal}
              duplicateIteration={duplicateIteration}
              addAssignment={addAssignment}
              moveAssignment={moveAssignment}
              setAssignmentMilestone={setAssignmentMilestone}
              removeAssignment={removeAssignment}
              setWeekNote={setWeekNote}
              onTextFocus={onTextFocus}
              onTextBlur={onTextBlur}
            />
          )}
        </div>

        {/* Resize grabber (only when expanded) */}
        {!panel.collapsed && (
          <div
            className="group relative h-2 cursor-row-resize border-y border-ink-200 bg-ink-50/60"
            onMouseDown={onResizeStart}
            title="Drag to resize"
          >
            <div className="pointer-events-none absolute left-1/2 top-1/2 h-[3px] w-9 -translate-x-1/2 -translate-y-1/2 rounded-full bg-ink-300 opacity-60 transition group-hover:bg-ink-400 group-hover:opacity-100" />
          </div>
        )}

        {/* Projects panel */}
        <div
          className="flex flex-col overflow-hidden border-t border-ink-200 bg-white shadow-[0_-2px_24px_rgba(15,23,42,0.04)] transition-[height] duration-200 ease-out"
          style={{ height: panel.collapsed ? 48 : panel.height }}
        >
          <div className="flex shrink-0 flex-nowrap items-center gap-3 overflow-hidden border-b border-ink-200 bg-gradient-to-b from-ink-50/60 to-white px-5 py-2.5">
            <button
              className="-ml-1 flex h-7 w-7 items-center justify-center rounded-md text-ink-500 transition hover:bg-ink-100 hover:text-ink-900"
              onClick={() => setPanel(p => ({ ...p, collapsed: !p.collapsed }))}
              title={panel.collapsed ? 'Expand projects' : 'Collapse projects'}
              aria-label="Toggle projects panel"
            >
              <Chevron open={!panel.collapsed} />
            </button>
            <h2 className="text-[15px] font-semibold tracking-tight text-ink-900">
              Projects
            </h2>
            <span className="rounded-full bg-ink-100 px-2 py-0.5 text-[11px] font-semibold tabular-nums text-ink-600">
              {activeInitiatives.length}
            </span>
            {descopedInitiatives.length > 0 && (
              <span
                className="rounded-full bg-ink-100 px-2 py-0.5 text-[11px] font-medium text-ink-500"
                title={`${descopedInitiatives.length} descoped`}
              >
                +{descopedInitiatives.length} descoped
              </span>
            )}
            {!panel.collapsed && unrankedCount > 0 && (
              <span
                className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-800"
                title="Some projects don't have a priority — they sort last"
              >
                {unrankedCount} unranked
              </span>
            )}
            <span className="flex-1" />
            {!panel.collapsed && (
              <>
                <label className="inline-flex cursor-pointer select-none items-center gap-1.5 rounded-md px-2 py-1 text-[12px] text-ink-600 hover:bg-ink-100">
                  <input
                    type="checkbox"
                    checked={showWhatFits}
                    onChange={e => setShowWhatFits(e.target.checked)}
                    className="h-3.5 w-3.5"
                  />
                  Show what fits
                </label>
                <button
                  type="button"
                  onClick={() => {
                    const id = addProject();
                    setIsAddingProject(true);
                    setEditingProjectId(id);
                  }}
                  className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md bg-brand-600 px-3 text-[12px] font-semibold text-white shadow-sm transition hover:bg-brand-700 active:scale-[0.98]"
                >
                  <span className="text-[14px] leading-none">+</span> Add project
                </button>
              </>
            )}
          </div>
          {!panel.collapsed && activeInitiatives.length > 0 && (
            <div className="shrink-0 border-b border-ink-100 px-5 py-2.5">
              <CapacityBars
                info={cap}
                initiatives={activeInitiatives}
                plannedByProject={plannedByProject}
                onConfigureQuarter={() => setQuarterModalOpen(true)}
                highlightedProjectId={highlightedProjectId}
                onHoverProject={setHighlightedProjectId}
              />
            </div>
          )}
          {!panel.collapsed && (
            <div className="flex-1 overflow-auto">
              <PrioritizationTable
                initiatives={activeInitiatives}
                people={state.people}
                peopleById={peopleById}
                capacityEM={cap.capacityEM}
                demandEM={cap.demandEM}
                fitMarkerIndex={fitMarkerIndex}
                showWhatFits={showWhatFits}
                addInitiative={() => {
                  if (panel.collapsed) setPanel(p => ({ ...p, collapsed: false }));
                  const id = addProject();
                  setIsAddingProject(true);
                  setEditingProjectId(id);
                }}
                updateProject={updateProject}
                descopeInitiative={descopeProject}
                removeInitiative={removeProject}
                moveProjectToIndex={moveProjectToIndex}
                weeksPerEM={cap.quarter.weeksPerEM}
                plannedByProject={plannedByProject}
                doneProjectIds={doneProjectIds}
                onEdit={editProject}
                highlightedProjectId={highlightedProjectId}
                onHoverProject={setHighlightedProjectId}
              />
              {descopedInitiatives.length > 0 && (
                <DescopedDrawer
                  descoped={descopedInitiatives}
                  restoreInitiative={restoreProject}
                  removeInitiative={removeProject}
                />
              )}
            </div>
          )}
        </div>
      </div>
    </div>
    {quarterModalOpen && (
      <QuarterModal
        open={quarterModalOpen}
        onClose={() => setQuarterModalOpen(false)}
        info={cap}
        updateQuarter={updateQuarter}
        addBuffer={addBuffer}
        updateBuffer={updateBuffer}
        removeBuffer={removeBuffer}
        installDefaultBuffers={installDefaultBuffers}
      />
    )}
    {editingProject && (
      <ProjectEditModal
        project={editingProject}
        people={state.people}
        planned={plannedByProject[editingProject.id] ?? 0}
        weeksPerEM={state.quarter?.weeksPerEM ?? 4}
        onUpdate={patch => updateProject(editingProject.id, patch)}
        onAddMilestones={items => addMilestones(editingProject.id, items)}
        onSyncMilestones={found => syncMilestones(editingProject.id, found)}
        onUpdateMilestone={(milestoneId, patch) => updateMilestone(editingProject.id, milestoneId, patch)}
        onRemoveMilestone={milestoneId => removeMilestone(editingProject.id, milestoneId)}
        assignedByMilestone={assignedByMilestone}
        onRemove={() => removeProject(editingProject.id)}
        onClose={() => { setEditingProjectId(null); setIsAddingProject(false); }}
        isNew={isAddingProject}
        slug={slug}
        projects={state.projects}
      />
    )}
    {passwordDialog && (
      <PasswordDialog
        mode={passwordDialog}
        hasPassword={hasPassword}
        onClose={() => setPasswordDialog(null)}
        changePassword={changePassword}
      />
    )}
    {undoToast && canUndoToast(undoStackRef.current, undoToast) && (
      <UndoToast
        id={undoToast.id}
        message={undoToast.message}
        onUndo={undoFromToast}
        onDismiss={dismissUndoToast}
      />
    )}
    </>
  );
}

/* ============================================================ */
/* Brand + tiny widgets                                          */
/* ============================================================ */

function Presence({ conn, peers }: { conn: ConnState; peers: number }) {
  const dotColor =
    conn === 'open' ? 'bg-emerald-500'
    : conn === 'connecting' ? 'bg-amber-500 animate-pulse'
    : 'bg-rose-500';
  const label =
    conn === 'open' ? (peers > 1 ? `${peers} live` : 'Live')
    : conn === 'connecting' ? 'Connecting…'
    : 'Offline';
  const title =
    conn === 'open'
      ? `${peers} ${peers === 1 ? 'person' : 'people'} on this plan`
      : conn === 'connecting' ? 'Connecting to live sync'
      : 'Disconnected — changes will sync when reconnected';
  return (
    <div
      className="inline-flex h-7 items-center gap-1.5 rounded-md border border-ink-200 bg-white px-2.5 text-[11px] font-medium text-ink-600 shadow-sm"
      title={title}
    >
      <span className={'h-2 w-2 rounded-full ' + dotColor} />
      {label}
    </div>
  );
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 14 14"
      fill="none"
      className={'transition-transform duration-200 ' + (open ? '' : '-rotate-90')}
      aria-hidden
    >
      <path d="M3 5l4 4 4-4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function IconToolbarButton(props: {
  children: React.ReactNode;
  onClick?: () => void;
  title?: string;
  disabled?: boolean;
  label?: string;
}) {
  return (
    <button
      type="button"
      onClick={props.disabled ? undefined : props.onClick}
      title={props.title}
      disabled={props.disabled}
      aria-label={props.label}
      className={
        'inline-flex h-7 w-7 items-center justify-center rounded-md text-[14px] leading-none transition active:scale-[0.92] ' +
        (props.disabled
          ? 'text-ink-300 cursor-not-allowed'
          : 'text-ink-500 hover:bg-ink-100 hover:text-ink-900')
      }
    >
      {props.children}
    </button>
  );
}

type OverflowItem =
  | { divider: true; label?: undefined; onClick?: undefined; title?: undefined; danger?: undefined; icon?: undefined; sectionLabel?: undefined }
  | { divider?: false; sectionLabel?: undefined; label: string; onClick: () => void; title?: string; danger?: boolean; icon?: React.ReactNode }
  | { sectionLabel: string; divider?: undefined; label?: undefined; onClick?: undefined; title?: undefined; danger?: undefined; icon?: undefined };

/* Compact 14×14 line icons used in the overflow menu. */
const iconSvg = (path: React.ReactNode) => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    {path}
  </svg>
);
const IconUndo = () => iconSvg(<><path d="M5.5 3.5L2.5 6.5l3 3" /><path d="M2.5 6.5h7a3.5 3.5 0 0 1 0 7H7" /></>);
const IconRedo = () => iconSvg(<><path d="M10.5 3.5l3 3-3 3" /><path d="M13.5 6.5h-7a3.5 3.5 0 0 0 0 7H9" /></>);
const IconArrowLeft = () => iconSvg(<><path d="M12.5 8H3.5" /><path d="M7 4l-3.5 4L7 12" /></>);
const IconGear = () => iconSvg(<>
  <circle cx="8" cy="8" r="2.25" />
  <path d="M8 1.5v1.7M8 12.8v1.7M14.5 8h-1.7M3.2 8H1.5M12.6 3.4l-1.2 1.2M4.6 11.4l-1.2 1.2M12.6 12.6l-1.2-1.2M4.6 4.6L3.4 3.4" />
</>);
const IconAlert = () => iconSvg(<>
  <path d="M8 2.5L14.5 13.5h-13L8 2.5z" />
  <path d="M8 6.5v3" />
  <path d="M8 11.5v.5" />
</>);
const IconClipboard = () => iconSvg(<>
  <rect x="4" y="3" width="8" height="11" rx="1.25" />
  <rect x="6" y="1.5" width="4" height="2.5" rx="0.75" fill="currentColor" stroke="none" />
</>);
const IconSwap = () => iconSvg(<>
  <path d="M3 5h9" />
  <path d="M9.5 2.5L12 5L9.5 7.5" />
  <path d="M13 11H4" />
  <path d="M6.5 8.5L4 11l2.5 2.5" />
</>);
const IconSun = () => iconSvg(<>
  <circle cx="8" cy="8" r="2.75" />
  <path d="M8 1.5v1.5M8 13v1.5M1.5 8h1.5M13 8h1.5M3.4 3.4l1.1 1.1M11.5 11.5l1.1 1.1M3.4 12.6l1.1-1.1M11.5 4.5l1.1-1.1" />
</>);
const IconMoon = () => iconSvg(<path d="M13.5 9.5A5.5 5.5 0 0 1 6.5 2.5a5.5 5.5 0 1 0 7 7z" fill="currentColor" stroke="none" />);
const IconLock = () => iconSvg(<>
  <rect x="3.5" y="7" width="9" height="6.5" rx="1.25" />
  <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" />
</>);
const IconUnlock = () => iconSvg(<>
  <rect x="3.5" y="7" width="9" height="6.5" rx="1.25" />
  <path d="M5.5 7V5a2.5 2.5 0 0 1 4.9-0.6" />
</>);
const IconTrash = () => iconSvg(<>
  <path d="M2.5 4.5h11" />
  <path d="M5 4.5V3a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v1.5" />
  <path d="M3.75 4.5l.75 9a1 1 0 0 0 1 .9h5a1 1 0 0 0 1-.9l.75-9" />
</>);

function OverflowMenu(props: { items: OverflowItem[] }) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (popRef.current?.contains(e.target as Node)) return;
      if (btnRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="relative">
      <button
        ref={btnRef}
        type="button"
        onClick={() => setOpen(o => !o)}
        title="More options"
        aria-label="More options"
        className="inline-flex h-7 w-7 items-center justify-center rounded-md text-[16px] leading-none text-ink-500 transition hover:bg-ink-100 hover:text-ink-900 active:scale-[0.92]"
      >
        ⋯
      </button>
      {open && (
        <div
          ref={popRef}
          className="anim-pop-in absolute right-0 top-9 z-50 w-60 overflow-hidden rounded-xl border border-ink-200 bg-white py-1.5 shadow-xl shadow-ink-900/10"
        >
          {props.items.map((item, i) => {
            if (item.divider) return <div key={i} className="my-1 border-t border-ink-100" />;
            if (item.sectionLabel) {
              return (
                <div key={i} className="px-3 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-400">
                  {item.sectionLabel}
                </div>
              );
            }
            return (
              <button
                key={i}
                type="button"
                title={item.title}
                onClick={() => { setOpen(false); btnRef.current?.focus(); item.onClick?.(); }}
                className={
                  'flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-[13px] transition ' +
                  (item.danger
                    ? 'text-rose-600 hover:bg-rose-50'
                    : 'text-ink-700 hover:bg-ink-100 hover:text-ink-900')
                }
              >
                <span className="inline-flex h-4 w-4 shrink-0 items-center justify-center text-ink-500" aria-hidden>
                  {item.icon}
                </span>
                <span className="flex-1 truncate">{item.label}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function PasswordDialog(props: {
  mode: 'set' | 'change' | 'remove';
  hasPassword: boolean;
  onClose: () => void;
  changePassword: (args: { currentPassword?: string; newPassword: string | null }) => Promise<
    { ok: true } | { ok: false; error: PasswordError; message?: string }
  >;
}) {
  const { mode, hasPassword, onClose, changePassword } = props;
  const [currentPw, setCurrentPw] = useState('');
  const [newPw, setNewPw] = useState('');
  const [confirmPw, setConfirmPw] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const title = mode === 'set' ? 'Set a password' : mode === 'change' ? 'Change password' : 'Remove password';
  const accent = mode === 'remove' ? 'rose' : 'brand';

  // Esc to close.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !submitting) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, submitting]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    setErr(null);

    if (mode !== 'set' && hasPassword && !currentPw) {
      setErr('Enter the current password.');
      return;
    }
    if (mode !== 'remove') {
      if (newPw.length < 4) {
        setErr('Password must be at least 4 characters.');
        return;
      }
      if (newPw !== confirmPw) {
        setErr('Passwords do not match.');
        return;
      }
    }

    setSubmitting(true);
    const result = await changePassword({
      currentPassword: hasPassword ? currentPw : undefined,
      newPassword: mode === 'remove' ? null : newPw,
    });
    setSubmitting(false);
    if (!result.ok) {
      if (result.error === 'auth_required') setErr('Current password is incorrect.');
      else if (result.error === 'password_too_short') setErr(result.message ?? 'Password must be at least 4 characters.');
      else setErr(result.message ?? 'Something went wrong. Try again.');
      return;
    }
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-ink-900/40 p-6 backdrop-blur-sm"
      onMouseDown={(e) => { if (e.target === e.currentTarget && !submitting) onClose(); }}
    >
      <form
        onSubmit={submit}
        className="w-full max-w-sm rounded-2xl border border-ink-200 bg-white p-6 shadow-2xl shadow-ink-900/30"
      >
        <h2 className="text-[16px] font-semibold text-ink-900">{title}</h2>
        {mode === 'set' && (
          <p className="mt-1 text-[12.5px] text-ink-500">
            Anyone visiting this plan will need the password before they can view or edit it.
            <span className="mt-2 block rounded-md bg-amber-50 px-2.5 py-1.5 text-[11.5px] text-amber-800">
              ⚠ There is no recovery if forgotten — choose something memorable or save it somewhere safe.
            </span>
          </p>
        )}
        {mode === 'remove' && (
          <p className="mt-1 text-[12.5px] text-ink-500">
            Anyone with the plan URL will be able to view and edit it again.
          </p>
        )}

        {hasPassword && (
          <label className="mt-4 block">
            <span className="mb-1 block text-[11.5px] font-semibold uppercase tracking-[0.06em] text-ink-500">Current password</span>
            <input
              type="password"
              autoFocus
              value={currentPw}
              onChange={e => setCurrentPw(e.target.value)}
              className="block w-full rounded-lg border border-ink-300 bg-white px-3 py-2 text-[13px] text-ink-900 outline-none transition focus:border-brand-400 focus:ring-2 focus:ring-brand-200"
            />
          </label>
        )}

        {mode !== 'remove' && (
          <>
            <label className="mt-3 block">
              <span className="mb-1 block text-[11.5px] font-semibold uppercase tracking-[0.06em] text-ink-500">New password</span>
              <input
                type="password"
                autoFocus={!hasPassword}
                value={newPw}
                onChange={e => setNewPw(e.target.value)}
                className="block w-full rounded-lg border border-ink-300 bg-white px-3 py-2 text-[13px] text-ink-900 outline-none transition focus:border-brand-400 focus:ring-2 focus:ring-brand-200"
              />
            </label>
            <label className="mt-3 block">
              <span className="mb-1 block text-[11.5px] font-semibold uppercase tracking-[0.06em] text-ink-500">Confirm new password</span>
              <input
                type="password"
                value={confirmPw}
                onChange={e => setConfirmPw(e.target.value)}
                className="block w-full rounded-lg border border-ink-300 bg-white px-3 py-2 text-[13px] text-ink-900 outline-none transition focus:border-brand-400 focus:ring-2 focus:ring-brand-200"
              />
            </label>
          </>
        )}

        {err && (
          <div className="mt-3 rounded-md bg-rose-50 px-2.5 py-1.5 text-[12px] text-rose-700">{err}</div>
        )}

        <div className="mt-5 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="inline-flex h-9 items-center rounded-lg px-3 text-[12.5px] font-medium text-ink-600 transition hover:bg-ink-100 hover:text-ink-900 disabled:opacity-60"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={submitting}
            className={
              'inline-flex h-9 items-center rounded-lg px-4 text-[12.5px] font-semibold text-[#fff] shadow-sm transition active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-60 ' +
              (accent === 'rose'
                ? 'bg-rose-600 hover:bg-rose-700'
                : 'bg-brand-600 hover:bg-brand-700')
            }
          >
            {submitting
              ? (mode === 'remove' ? 'Removing…' : 'Saving…')
              : (mode === 'set' ? 'Set password' : mode === 'change' ? 'Change password' : 'Remove password')}
          </button>
        </div>
      </form>
    </div>
  );
}

function IconButton(props: {
  onClick?: (e: React.MouseEvent) => void;
  title?: string;
  danger?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={props.onClick}
      title={props.title}
      className={
        'inline-flex h-[22px] w-[22px] items-center justify-center rounded text-[14px] leading-none text-ink-400 transition ' +
        (props.danger
          ? 'hover:bg-rose-50 hover:text-rose-600'
          : 'hover:bg-ink-100 hover:text-ink-800') +
        (props.className ? ' ' + props.className : '')
      }
    >
      {props.children}
    </button>
  );
}

/* ============================================================ */
/* Chart                                                         */
/* ============================================================ */

const DuplicateIcon = () => (
  <svg width="11" height="11" viewBox="0 0 14 14" fill="none" aria-hidden>
    <rect x="4.5" y="4.5" width="7.5" height="7.5" rx="1.2" stroke="currentColor" strokeWidth="1.3" />
    <path d="M2.5 9.5V3a1 1 0 0 1 1-1H10" stroke="currentColor" strokeWidth="1.3" fill="none" strokeLinecap="round" />
  </svg>
);

function IterationGoal(props: {
  goal?: string;
  onChange: (s: string) => void;
  onTextFocus: () => void;
  onTextBlur: () => void;
  className?: string;
  placeholder?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(props.goal ?? '');
  useEffect(() => {
    if (!editing) setValue(props.goal ?? '');
  }, [props.goal, editing]);

  const commit = () => {
    setEditing(false);
    props.onTextBlur();
    if (value.trim() !== (props.goal ?? '')) props.onChange(value);
  };

  const className = props.className ?? '';
  if (editing) {
    return (
      <input
        autoFocus
        value={value}
        onChange={e => setValue(e.target.value)}
        onFocus={props.onTextFocus}
        onBlur={commit}
        onKeyDown={e => {
          if (e.key === 'Enter') (e.currentTarget as HTMLInputElement).blur();
          if (e.key === 'Escape') {
            setValue(props.goal ?? '');
            setEditing(false);
            props.onTextBlur();
            (e.currentTarget as HTMLInputElement).blur();
          }
        }}
        placeholder={props.placeholder ?? 'Goal for this iteration…'}
        className={
          'min-w-0 rounded border border-current/30 bg-white/40 px-1.5 py-px text-[10.5px] font-medium tracking-normal normal-case outline-none focus:border-current/60 focus:bg-white/70 ' +
          className
        }
        onClick={e => e.stopPropagation()}
      />
    );
  }
  return (
    <button
      type="button"
      onClick={e => { e.stopPropagation(); setEditing(true); }}
      title={props.goal ? 'Edit iteration goal' : 'Add a goal for this iteration'}
      className={
        'min-w-0 truncate rounded px-1.5 py-px text-left text-[10.5px] font-medium tracking-normal normal-case transition hover:bg-white/50 ' +
        (props.goal ? 'opacity-90 ' : 'italic ' + ITER_REVEAL + ' ') +
        className
      }
    >
      {props.goal || '+ goal'}
    </button>
  );
}

/** A bar's label sits on its first week. When that week is scrolled behind the
 *  frozen headers, show the label on the week at the edge instead. */
function useRunLabelReveal(scrollRef: React.RefObject<HTMLElement | null>, vertical: boolean) {
  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      const corner = scroller.querySelector('[data-chart-corner]');
      if (!corner) return;
      const box = corner.getBoundingClientRect();
      const edge = vertical ? box.bottom : box.right;
      scroller.querySelectorAll<HTMLElement>('[data-run-cont]').forEach(el => {
        // Label the segment whose cell holds the first readable stretch of
        // the bar past the sticky corner.
        const r = (el.closest('td') ?? el).getBoundingClientRect();
        const line = edge + (vertical ? 24 : 48);
        el.toggleAttribute(
          'data-show-label',
          vertical ? r.top < line && r.bottom > line : r.left < line && r.right > line,
        );
      });
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    schedule();
    scroller.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule);
    const observer = new MutationObserver(schedule);
    observer.observe(scroller, { childList: true, subtree: true });
    return () => {
      cancelAnimationFrame(frame);
      scroller.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
      observer.disconnect();
    };
  }, [scrollRef, vertical]);
}

/** Lane layout for drawing consecutive weeks of the same work as one bar. */
function useRunLayout(
  assignments: Assignment[],
  iterationRows: { isCollapsed: boolean; weeks: WeekInfo[] }[],
  projectsById: Record<ID, Project>,
): RunLayout {
  return useMemo(
    () => layoutRuns(
      assignments,
      iterationRows.flatMap(row => row.isCollapsed ? [null] : row.weeks.map(w => w.id)),
      {
        isBlocker: a => isUnavailable(a.projectId),
        isTall: a => !isSentinel(a.projectId) && !!milestoneOf(lookupProject(projectsById, a.projectId), a.milestoneId),
      },
    ),
    [assignments, iterationRows, projectsById],
  );
}

const ITER_REVEAL =
  'opacity-0 group-hover/iter:opacity-50 group-focus-within/iter:opacity-50 [@media(hover:none)]:opacity-50 hover:!opacity-100 focus-visible:!opacity-100 focus-within:!opacity-100';

function Chart(props: {
  state: State;
  allWeeks: WeekInfo[];
  projectsById: Record<ID, Project>;
  releasesByWeek: Record<string, ScheduledRelease[]>;
  onEditProject: (id: ID) => void;
  collapsedIterationIds: Set<ID>;
  currentIterationId: ID | null;
  currentWeekId: string | null;
  iterationToneById: Record<ID, IterationTone>;
  highlightedProjectId: ID | null;
  toggleIterationCollapsed: (id: ID) => void;
  renamePerson: (id: ID, name: string) => void;
  movePerson: (id: ID, dir: -1 | 1) => void;
  removePerson: (id: ID) => void;
  addPerson: (name?: string) => void;
  addIteration: () => void;
  removeIteration: (id: ID) => void;
  setIterationStart: (id: ID, isoDate: string) => void;
  setIterationGoal: (id: ID, goal: string) => void;
  duplicateIteration: (id: ID) => void;
  addAssignment: (personId: ID, weekId: string, projectId: ID, milestoneId?: ID) => void;
  moveAssignment: (assignmentId: ID, personId: ID, weekId: string) => void;
  setAssignmentMilestone: (assignmentId: ID, milestoneId: ID | undefined) => void;
  removeAssignment: (id: ID) => void;
  setWeekNote: (weekId: string, text: string) => void;
  onTextFocus: () => void;
  onTextBlur: () => void;
}) {
  const { state, allWeeks, projectsById } = props;
  const [picker, setPicker] = useState<{ personId: ID; weekId: string; rect: DOMRect } | null>(null);
  const iterationRows = useMemo(
    () => state.iterations.map((iter, idx) => ({
      iter,
      idx,
      tone: props.iterationToneById[iter.id] ?? 'future',
      isCollapsed: props.collapsedIterationIds.has(iter.id),
      weeks: allWeeks.filter(w => w.iterationId === iter.id),
    })),
    [allWeeks, props.collapsedIterationIds, props.iterationToneById, state.iterations],
  );
  const visibleWeeks = useMemo(
    () => iterationRows.flatMap(row => row.isCollapsed ? [] : row.weeks),
    [iterationRows],
  );
  const visibleWeekIndexById = useMemo(() => {
    const indexById: Record<string, number> = {};
    visibleWeeks.forEach((week, idx) => {
      indexById[week.id] = idx;
    });
    return indexById;
  }, [visibleWeeks]);
  const timelineColumnCount = iterationRows.reduce(
    (count, row) => count + (row.isCollapsed ? 1 : row.weeks.length),
    0,
  );
  const runLayout = useRunLayout(state.assignments, iterationRows, projectsById);

  /* ------ Click-drag-to-extend ------
   * When the user grabs the right edge of a chip and drags right, we add
   * assignments for the same project in the consecutive weeks they hover.
   * Live preview is stored in `extending`; we commit on mouseup.
   */
  const [extending, setExtending] = useState<null | {
    personId: ID;
    projectId: ID;
    milestoneId?: ID;
    fromIdx: number;
    toIdx: number;
  }>(null);

  const startExtend = (personId: ID, projectId: ID, milestoneId: ID | undefined, weekId: string) => {
    const fromIdx = visibleWeeks.findIndex(w => w.id === weekId);
    if (fromIdx === -1) return;
    setExtending({ personId, projectId, milestoneId, fromIdx, toIdx: fromIdx });

    const onMove = (e: MouseEvent) => {
      const el = (document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null)?.closest(
        '[data-cell="1"]',
      ) as HTMLElement | null;
      if (!el) return;
      if (el.dataset.pid !== personId) return;
      const idx = visibleWeeks.findIndex(w => w.id === el.dataset.wid);
      if (idx < fromIdx) return; // only extend forward
      setExtending(prev => (prev && prev.toIdx !== idx ? { ...prev, toIdx: idx } : prev));
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      setExtending(curr => {
        if (curr) {
          for (let i = curr.fromIdx + 1; i <= curr.toIdx; i++) {
            const w = visibleWeeks[i];
            if (w) props.addAssignment(curr.personId, w.id, curr.projectId, curr.milestoneId);
          }
        }
        return null;
      });
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  // The week header row sticks just below the iteration row, whose height depends on its content.
  const iterRowRef = useRef<HTMLTableRowElement>(null);
  const [iterRowH, setIterRowH] = useState(36);
  useLayoutEffect(() => {
    const el = iterRowRef.current;
    if (!el) return;
    const measure = () => setIterRowH(el.offsetHeight);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return (
    <div
      className={
        'inline-block min-w-full overflow-clip rounded-2xl border border-ink-200 bg-white shadow-[0_1px_2px_rgba(15,23,42,0.04),0_8px_24px_-12px_rgba(15,23,42,0.08)]' +
        (extending ? ' select-none' : '')
      }
    >
      <table className="border-separate border-spacing-0" style={{ '--iter-row-h': `${iterRowH}px` } as React.CSSProperties}>
        <thead>
          {/* Iteration row */}
          <tr ref={iterRowRef}>
            <th
              rowSpan={2}
              data-chart-corner
              className="sticky left-0 top-0 z-30 w-[128px] min-w-[128px] border-b border-r-2 border-ink-200 border-r-ink-300 bg-ink-50 pl-5 pr-2 py-3 text-left align-bottom text-[10.5px] font-semibold uppercase tracking-[0.08em] text-ink-500 sm:w-[200px] sm:min-w-[200px]"
            >
              <div className="flex items-center justify-between gap-2">
                <span>Person</span>
                <button
                  type="button"
                  onClick={() => props.addPerson()}
                  title="Add person"
                  className="inline-flex h-6 w-6 items-center justify-center rounded-md border border-ink-200 bg-white text-[14px] font-semibold leading-none text-ink-600 shadow-sm transition hover:border-brand-300 hover:bg-brand-50 hover:text-brand-700"
                >
                  +
                </button>
              </div>
            </th>
            {iterationRows.map(({ iter, idx, tone, isCollapsed }) => {
              const isCurrent = tone === 'current';
              const isPast = tone === 'past';
              return (
                <th
                  key={iter.id}
                  data-iter-id={iter.id}
                  colSpan={isCollapsed ? 1 : 2}
                  className={
                    'group/iter sticky top-0 z-20 border-b-2 border-r-2 px-2 py-1 text-[11px] font-semibold uppercase tracking-[0.08em] ' +
                    (isCurrent
                      ? 'border-amber-500 border-r-amber-400/70 bg-amber-100 text-amber-800'
                      : isPast
                        ? 'border-ink-200 border-r-ink-300 bg-ink-100 text-ink-500'
                        : (idx % 2 === 0
                            ? 'border-ink-200 border-r-ink-300 bg-brand-50 text-brand-700'
                            : 'border-ink-200 border-r-ink-300 bg-indigo-50 text-indigo-700'))
                  }
                >
                  <div className="flex flex-col items-center gap-0.5">
                  <div className="flex items-center justify-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => props.toggleIterationCollapsed(iter.id)}
                      title={isCollapsed ? 'Expand iteration' : 'Collapse iteration'}
                      aria-label={isCollapsed ? 'Expand iteration' : 'Collapse iteration'}
                      className="inline-flex h-4 w-4 items-center justify-center rounded text-current opacity-60 transition hover:bg-white/50 hover:opacity-100"
                    >
                      <Chevron open={!isCollapsed} />
                    </button>
                    <span>Iteration</span>
                    <span
                      className={
                        'rounded px-1 py-px text-[10px] font-medium ' +
                        (isCurrent
                          ? 'bg-white/80 text-amber-700'
                          : isPast ? 'bg-white/70 text-ink-500' : 'bg-white/60 text-ink-500')
                      }
                    >
                      {idx + 1}
                    </span>
                    {isCurrent && (
                      <span
                        className="rounded-full bg-amber-500 px-1.5 py-px text-[9px] font-bold uppercase tracking-[0.08em] text-[#fff]"
                        title="Today is in this iteration"
                      >
                        Now
                      </span>
                    )}
                    <label
                      className={'relative ml-0.5 inline-flex h-4 w-4 cursor-pointer items-center justify-center rounded text-current transition hover:bg-white/50 ' + ITER_REVEAL}
                      title={`Set start date (currently ${iter.startDate})`}
                    >
                      <svg width="11" height="11" viewBox="0 0 14 14" fill="none" aria-hidden>
                        <rect x="2" y="3" width="10" height="9" rx="1.5" stroke="currentColor" strokeWidth="1.3" />
                        <path d="M2 6h10" stroke="currentColor" strokeWidth="1.3" />
                        <path d="M5 2v2M9 2v2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
                      </svg>
                      <input
                        type="date"
                        value={iter.startDate}
                        onChange={e => {
                          if (e.target.value) props.setIterationStart(iter.id, e.target.value);
                        }}
                        className="absolute inset-0 cursor-pointer opacity-0"
                        aria-label="Iteration start date"
                      />
                    </label>
                    <button
                      type="button"
                      onClick={() => props.duplicateIteration(iter.id)}
                      title="Duplicate this iteration (copies all assignments to a new iteration at the end)"
                      aria-label="Duplicate iteration"
                      className={'inline-flex h-4 w-4 items-center justify-center rounded text-current transition hover:bg-white/50 ' + ITER_REVEAL}
                    >
                      <DuplicateIcon />
                    </button>
                    <button
                      onClick={() => {
                        props.removeIteration(iter.id);
                      }}
                      title="Remove iteration"
                      aria-label="Remove iteration"
                      className={'ml-0.5 inline-flex h-4 w-4 items-center justify-center rounded text-current transition hover:bg-white/50 ' + ITER_REVEAL}
                    >
                      ×
                    </button>
                  </div>
                  {!isCollapsed && (
                    <IterationGoal
                      goal={iter.goal}
                      onChange={g => props.setIterationGoal(iter.id, g)}
                      onTextFocus={props.onTextFocus}
                      onTextBlur={props.onTextBlur}
                      className="max-w-full"
                    />
                  )}
                  </div>
                </th>
              );
            })}
            <th rowSpan={2} className="sticky top-0 z-20 w-10 border-b border-ink-200 bg-ink-50 px-2 align-middle">
              <button
                type="button"
                onClick={props.addIteration}
                title="Add iteration"
                aria-label="Add iteration"
                className="inline-flex h-6 w-6 items-center justify-center rounded-md border border-ink-200 bg-white text-[14px] font-semibold leading-none text-ink-600 shadow-sm transition hover:border-brand-300 hover:bg-brand-50 hover:text-brand-700"
              >
                +
              </button>
            </th>
            {state.iterations.length === 0 && (
              <th
                rowSpan={2}
                className="sticky top-0 z-20 border-b border-ink-200 bg-ink-50 px-6 py-3 text-left text-[12px] font-normal text-ink-500"
              >
                Click <span className="rounded bg-white px-1.5 py-0.5 font-medium text-ink-700 ring-1 ring-ink-200">+</span> to add 2 weeks.
              </th>
            )}
          </tr>
          {/* Week row */}
          <tr>
            {iterationRows.map(({ iter, tone, isCollapsed, weeks }) => {
              const isCurrent = tone === 'current';
              const isPast = tone === 'past';
              const weekToneClass = isCurrent
                ? 'border-amber-300 bg-amber-50 text-amber-800'
                : isPast
                  ? 'border-ink-200 bg-ink-50 text-ink-400'
                  : 'border-ink-200 bg-ink-50/70 text-ink-600';
              if (isCollapsed) {
                return (
                  <th
                    key={`${iter.id}:collapsed`}
                    className={
                      'sticky top-[var(--iter-row-h)] z-20 h-6 min-w-[120px] cursor-pointer border-b border-r-2 border-r-ink-300 px-2 pt-2 align-top text-[10.5px] font-medium tabular-nums ' +
                      weekToneClass
                    }
                    onClick={() => props.toggleIterationCollapsed(iter.id)}
                    title={`Expand iteration (${iterationDateRange(iter)})`}
                  >
                    <span className="opacity-80">{iterationDateRange(iter)}</span>
                    <WeekReleases
                      releases={weeks.flatMap(w => props.releasesByWeek[w.id] ?? [])}
                      center
                      onEdit={props.onEditProject}
                    />
                  </th>
                );
              }
              return weeks.map((w, weekIdx) => {
                const isIterEnd = weekIdx === weeks.length - 1;
                const isToday = w.id === props.currentWeekId;
                const releases = props.releasesByWeek[w.id];
                return (
                  <th
                    key={w.id}
                    aria-current={isToday ? 'date' : undefined}
                    className={
                      'sticky top-[var(--iter-row-h)] z-20 h-8 min-w-[160px] border-b px-2 pt-2 text-center align-top text-[11px] font-medium tabular-nums ' +
                      weekToneClass +
                      ' border-r ' +
                      (isIterEnd
                        ? (isCurrent ? 'border-r-2 border-r-amber-400/70' : 'border-r-2 border-r-ink-300')
                        : (isCurrent ? 'border-r-amber-200' : 'border-r-ink-200'))
                    }
                  >
                    {isToday && <TodayDot />}
                    {w.label}
                    <WeekReleases releases={releases} center onEdit={props.onEditProject} />
                  </th>
                );
              });
            })}
          </tr>
        </thead>
        <tbody>
          {state.people.map((person, rowIdx) => (
            <tr key={person.id} className="group/row">
              <td
                className={
                  'sticky left-0 z-10 w-[128px] min-w-[128px] border-b-2 border-r-2 border-ink-200 border-r-ink-300 px-3 py-3 align-middle sm:w-[200px] sm:min-w-[200px] ' +
                  (rowIdx % 2 === 0 ? 'bg-white' : 'bg-ink-50')
                }
              >
                <div className="flex items-center gap-1">
                  <input
                    value={person.name}
                    onChange={e => props.renamePerson(person.id, e.target.value)}
                    onFocus={props.onTextFocus}
                    onBlur={props.onTextBlur}
                    className="w-0 min-w-0 flex-1 rounded border border-transparent bg-transparent px-2 py-1 text-[13px] font-medium text-ink-900 outline-none transition hover:bg-white hover:shadow-sm focus:border-ink-300 focus:bg-white focus:ring-2 focus:ring-brand-200"
                  />
                  <div className="flex flex-col opacity-0 group-hover/row:opacity-100">
                    <button
                      type="button"
                      onClick={() => props.movePerson(person.id, -1)}
                      disabled={rowIdx === 0}
                      className="px-0.5 text-[9px] leading-none text-ink-400 hover:text-ink-700 disabled:invisible"
                      title="Move up"
                    >▲</button>
                    <button
                      type="button"
                      onClick={() => props.movePerson(person.id, 1)}
                      disabled={rowIdx === state.people.length - 1}
                      className="px-0.5 text-[9px] leading-none text-ink-400 hover:text-ink-700 disabled:invisible"
                      title="Move down"
                    >▼</button>
                  </div>
                  <IconButton
                    danger
                    title="Remove person"
                    className="opacity-0 group-hover/row:opacity-100 focus:opacity-100"
                    onClick={() => {
                      props.removePerson(person.id);
                    }}
                  >
                    ×
                  </IconButton>
                </div>
              </td>
              {iterationRows.map(({ iter, tone, isCollapsed, weeks }) => {
                if (isCollapsed) {
                  return (
                    <CollapsedIterationCell
                      key={`${iter.id}:collapsed:${person.id}`}
                      rowAlt={rowIdx % 2 === 1}
                      tone={tone}
                      isIterEnd
                      onExpand={() => props.toggleIterationCollapsed(iter.id)}
                      assignments={summarizeIterationAssignments(state.assignments, person.id, iter.id)}
                      projectsById={projectsById}
                      personName={person.name}
                    />
                  );
                }
                return weeks.map((w, weekIdx) => {
                  const cellAssigns = state.assignments.filter(
                    a => a.personId === person.id && a.weekId === w.id,
                  );
                  const isDri = cellAssigns.some(
                    a => lookupProject(projectsById, a.projectId)?.driId === person.id,
                  );
                  const visibleWeekIdx = visibleWeekIndexById[w.id] ?? -1;
                  const inExtendPreview =
                    !!extending &&
                    extending.personId === person.id &&
                    visibleWeekIdx > extending.fromIdx &&
                    visibleWeekIdx <= extending.toIdx;
                  const extendPreviewProject = inExtendPreview
                    ? lookupProject(projectsById, extending!.projectId)
                    : undefined;
                  return (
                    <Cell
                      key={w.id}
                      rowAlt={rowIdx % 2 === 1}
                      personId={person.id}
                      weekId={w.id}
                      assignments={cellAssigns}
                      projectsById={projectsById}
                      isDri={isDri}
                      isIterEnd={weekIdx === weeks.length - 1}
                      isCurrentWeek={tone === 'current'}
                      isPastWeek={tone === 'past'}
                      highlightedProjectId={props.highlightedProjectId}
                      extendPreviewProject={extendPreviewProject}
                      extendPreviewMilestone={inExtendPreview ? milestoneOf(extendPreviewProject, extending!.milestoneId) : undefined}
                      onAdd={pid => props.addAssignment(person.id, w.id, pid)}
                      onMove={aid => props.moveAssignment(aid, person.id, w.id)}
                      onRemove={props.removeAssignment}
                      onPick={rect => setPicker({ personId: person.id, weekId: w.id, rect })}
                      onStartExtend={(projectId, milestoneId) => startExtend(person.id, projectId, milestoneId, w.id)}
                      onSetMilestone={props.setAssignmentMilestone}
                      lanes={runLayout.lanesByPerson[person.id]}
                      slots={runLayout.slots}
                    />
                  );
                });
              })}
            </tr>
          ))}
          <tr className="group/notesrow">
            <td
              className="sticky left-0 z-10 w-[128px] min-w-[128px] border-t-2 border-b border-r-2 border-ink-200 border-r-ink-300 bg-ink-50 px-5 py-2 align-middle text-[10.5px] font-semibold uppercase tracking-[0.08em] text-ink-500 sm:w-[200px] sm:min-w-[200px]"
            >
              Notes
            </td>
            {iterationRows.map(({ iter, tone, isCollapsed, weeks }) => {
              if (isCollapsed) {
                return (
                  <CollapsedNotesCell
                    key={`${iter.id}:notes-collapsed`}
                    tone={tone}
                    topBorder
                    onExpand={() => props.toggleIterationCollapsed(iter.id)}
                    notes={collectIterationNotes(state.weekNotes, weeks)}
                  />
                );
              }
              return weeks.map((w, weekIdx) => {
                const note = state.weekNotes?.[w.id] ?? '';
                return (
                  <td
                    key={w.id}
                    className={
                      'min-w-[160px] border-t-2 border-b border-r border-ink-200 p-1 align-top ' +
                      (tone === 'current'
                        ? 'bg-amber-50/40'
                        : tone === 'past' ? 'bg-ink-50/70' : 'bg-white') +
                      (weekIdx === weeks.length - 1 ? ' border-r-2 border-r-ink-300' : '')
                    }
                  >
                    <WeekNoteTextarea
                      value={note}
                      onChange={text => props.setWeekNote(w.id, text)}
                      title={note || 'Add a note for this week'}
                      muted={tone === 'past'}
                      onFocus={props.onTextFocus}
                      onBlur={props.onTextBlur}
                    />
                  </td>
                );
              });
            })}
          </tr>
          {state.people.length === 0 && (
            <tr>
              <td
                colSpan={Math.max(1, 1 + timelineColumnCount)}
                className="px-6 py-10 text-center text-[13px] text-ink-500"
              >
                Add a person above to get started.
              </td>
            </tr>
          )}
        </tbody>
      </table>

      {picker && (
        <ProjectPicker
          rect={picker.rect}
          projects={state.projects.filter(p => !p.descoped)}
          onPick={(pid, milestoneId) => {
            props.addAssignment(picker.personId, picker.weekId, pid, milestoneId);
            setPicker(null);
          }}
          onClose={() => setPicker(null)}
        />
      )}
    </div>
  );
}

function CollapsedIterationCell(props: {
  rowAlt: boolean;
  tone: IterationTone;
  isIterEnd?: boolean;
  onExpand: () => void;
  assignments: CollapsedAssignmentSummary[];
  projectsById: Record<ID, Project>;
  personName?: string;
}) {
  const bg =
    props.tone === 'current'
      ? (props.rowAlt ? 'bg-amber-50/60 hover:bg-amber-100' : 'bg-amber-50/40 hover:bg-amber-100')
      : props.tone === 'past'
        ? (props.rowAlt ? 'bg-ink-100/70 hover:bg-ink-100' : 'bg-ink-50/80 hover:bg-ink-100')
        : props.rowAlt
          ? 'bg-ink-50/60 hover:bg-brand-50/60'
          : 'bg-ink-50/30 hover:bg-brand-50/60';
  const summary = props.assignments;
  const totalWeeks = summary.reduce((acc, s) => acc + s.weeks, 0);
  const tooltipLines = summary
    .map(s => {
      const project = lookupProject(props.projectsById, s.projectId);
      const name = project?.name ?? 'Unknown';
      const milestones = s.milestoneIds
        .map(id => milestoneOf(project, id))
        .filter((m): m is Milestone => !!m)
        .map(milestoneLabel);
      return `${name}${milestones.length ? ` (${milestones.join(', ')})` : ''} · ${s.weeks} ${s.weeks === 1 ? 'wk' : 'wks'}`;
    });
  const tooltip =
    summary.length === 0
      ? 'Iteration is collapsed. Click to expand.'
      : `${props.personName ? props.personName + ': ' : ''}${tooltipLines.join('\n')}\n(Click to expand)`;

  return (
    <td
      className={
        'group/collapsed relative h-7 min-w-[28px] cursor-pointer border-b border-r border-ink-200 p-0 align-middle transition-colors ' +
        bg +
        (props.isIterEnd ? ' border-r-2 border-r-ink-300' : '')
      }
      onClick={props.onExpand}
      title={tooltip}
    >
      <div
        className="pointer-events-none absolute inset-0 opacity-50"
        style={{
          backgroundImage:
            'repeating-linear-gradient(135deg, transparent 0 6px, rgba(15,23,42,0.04) 6px 7px)',
        }}
        aria-hidden
      />
      <div className="relative flex h-full w-full items-center justify-center gap-1 px-2 py-1">
        {summary.length === 0 && (
          <span
            className="inline-block h-1 w-6 rounded-full bg-ink-300/60 transition group-hover/collapsed:bg-ink-400/80"
            aria-hidden
          />
        )}
        {summary.map(s => {
          const project = lookupProject(props.projectsById, s.projectId);
          if (!project) return null;
          const pto = isPto(s.projectId);
          const fr = isFR(s.projectId);
          const unavail = isUnavailable(s.projectId);
          const widthPx = Math.max(10, s.weeks * 14);
          return (
            <span
              key={s.projectId}
              className={
                'inline-block h-2.5 rounded-full ' +
                (pto
                  ? 'border border-dashed border-ink-400/70'
                  : fr
                  ? 'border border-amber-400/70'
                  : unavail
                  ? 'border border-ink-400/70'
                  : 'border border-black/10 shadow-[inset_0_1px_0_rgba(255,255,255,0.45)]')
              }
              style={{
                width: `${widthPx}px`,
                background: pto
                  ? 'repeating-linear-gradient(135deg,var(--pattern-fill-1) 0 4px,var(--color-ink-300) 4px 8px)'
                  : fr
                  ? '#fef3c7'
                  : unavail
                  ? 'var(--color-ink-400)'
                  : project.color,
              }}
              aria-hidden
            />
          );
        })}
        {summary.length > 0 && totalWeeks > 0 && (
          <span className="sr-only">
            {summary.length} {summary.length === 1 ? 'project' : 'projects'} hidden
          </span>
        )}
      </div>
    </td>
  );
}

const FORECAST_LABEL: Record<TargetStatus, string> = { 'on-track': 'On track', 'at-risk': 'At risk', late: 'Late' };
const FORECAST_DOT: Record<TargetStatus, string> = {
  'on-track': 'bg-emerald-500',
  'at-risk': 'bg-amber-500',
  late: 'bg-rose-600',
};

function TodayDot() {
  return <span className="mr-1.5 inline-block h-1.5 w-1.5 rounded-full bg-amber-500 align-middle" title="This week" aria-hidden />;
}

function describeRelease({ project, milestone, releaseDate, forecast }: ScheduledRelease) {
  const projectName = project.name || 'Untitled project';
  const name = milestone ? `${projectName} · ${milestoneLabel(milestone)}` : projectName;
  const day = (iso: string) => parseISODate(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const finish = forecast?.finishWeek
    ? `${day(forecast.finishWeek)}${forecast.finishWeekEnd ? `–${day(forecast.finishWeekEnd).replace(/^[A-Za-z]+ /, '')}` : ''}`
    : null;
  const forecastText = forecast
    ? `${FORECAST_LABEL[forecast.status]}${finish
      ? `, forecast to finish the week of ${finish}`
      : forecast.status === 'late' && releaseDate >= toISODate(startOfToday()) ? ', no finish in sight at the current pace' : ''}`
    : '';
  return {
    name,
    finish: forecast?.finishWeek ? day(forecast.finishWeek) : null,
    date: parseISODate(releaseDate).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }),
    kind: milestone ? 'Milestone ships' : 'Release',
    forecastText,
  };
}

const RELEASE_TEXT: Record<TargetStatus, string> = {
  'on-track': 'text-ink-600',
  'at-risk': 'text-amber-700',
  late: 'text-rose-600',
};

function RocketIcon() {
  return (
    <svg width="10" height="11" viewBox="0 0 14 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 opacity-70" aria-hidden>
      <path d="M7 1.5C4.5 3.5 4 6 4 10.5h6C10 6 9.5 3.5 7 1.5Z" />
      <path d="m4 7-2.5 3v3L4 11m6-4 2.5 3v3L10 11M5.5 13 7 15l1.5-2" />
    </svg>
  );
}

/** A week's releases as plain text under its date, like events on a calendar.
 *  Past three, the rest fold into "+N more". */
function WeekReleases({ releases, center, onEdit }: {
  releases: ScheduledRelease[] | undefined;
  center?: boolean;
  onEdit: (id: ID) => void;
}) {
  const [rect, setRect] = useState<DOMRect | null>(null);
  const moreRef = useRef<HTMLButtonElement>(null);
  if (!releases?.length) return null;
  const shown = releases.length > 3 ? releases.slice(0, 2) : releases;
  return (
    <ul aria-label="Releases" className={'mt-0.5 flex min-w-0 flex-col pb-1 ' + (center ? 'items-center' : 'items-start')}>
      {shown.map(r => {
        const d = describeRelease(r);
        const status = r.forecast?.status;
        return (
          <li key={r.key} className="flex max-w-full min-w-0">
            <button
              type="button"
              onClick={e => { e.stopPropagation(); onEdit(r.project.id); }}
              title={`${d.name}\n${d.kind} ${d.date}${d.forecastText ? `\n${d.forecastText}` : ''}`}
              className={
                'flex min-w-0 items-center gap-1 text-[10.5px] font-normal normal-case leading-4 tracking-normal hover:underline focus-visible:underline focus-visible:outline-none ' +
                (status ? RELEASE_TEXT[status] : 'text-ink-600')
              }
            >
              <RocketIcon />
              <span className="min-w-0 truncate">{d.name}</span>
              {status === 'late' && d.finish && <span className="shrink-0 tabular-nums">→ {d.finish}</span>}
            </button>
          </li>
        );
      })}
      {shown.length < releases.length && (
        <li>
          <button
            ref={moreRef}
            type="button"
            onClick={e => { e.stopPropagation(); setRect(rect ? null : e.currentTarget.getBoundingClientRect()); }}
            aria-expanded={!!rect}
            className="text-[10.5px] font-normal normal-case leading-4 tracking-normal text-ink-500 hover:text-ink-800 hover:underline"
          >
            +{releases.length - shown.length} more
          </button>
          {rect && (
            <ReleasesPopover
              rect={rect}
              trigger={moreRef}
              releases={releases}
              onEdit={id => { setRect(null); onEdit(id); }}
              onClose={refocus => { setRect(null); if (refocus) moreRef.current?.focus({ preventScroll: true }); }}
            />
          )}
        </li>
      )}
    </ul>
  );
}

function ReleasesPopover(props: {
  rect: DOMRect;
  trigger: React.RefObject<HTMLElement | null>;
  releases: ScheduledRelease[];
  onEdit: (id: ID) => void;
  /** `refocus` is true when focus should return to the trigger. */
  onClose: (refocus: boolean) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const { onClose, trigger } = props;
  const [top, setTop] = useState(props.rect.bottom + 6);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const h = el.offsetHeight;
    const below = props.rect.bottom + 6;
    if (below + h > window.innerHeight - 8) {
      const above = props.rect.top - 6 - h;
      setTop(above >= 8 ? above : Math.max(8, window.innerHeight - 8 - h));
    }
    el.querySelector('button')?.focus({ preventScroll: true });
  }, [props.rect]);
  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      if (ref.current?.contains(t) || trigger.current?.contains(t)) return;
      onClose(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(true); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);
  const w = 280;
  let left = props.rect.left - 8;
  if (left + w > window.innerWidth) left = window.innerWidth - w - 8;
  if (left < 8) left = 8;
  return createPortal(
    <div
      ref={ref}
      role="dialog"
      aria-label="Releases"
      onClick={e => e.stopPropagation()}
      className="anim-pop-in fixed z-50 flex flex-col gap-0.5 overflow-y-auto rounded-xl border border-ink-200 bg-white p-1.5 shadow-2xl"
      style={{ top, left, width: w, maxHeight: 'calc(100vh - 16px)' }}
    >
      {props.releases.map(r => {
        const d = describeRelease(r);
        return (
          <button
            key={r.key}
            type="button"
            onClick={() => props.onEdit(r.project.id)}
            title="Edit project"
            className="flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left transition hover:bg-ink-100 focus-visible:bg-ink-100 focus-visible:outline-none"
          >
            <span className={'mt-0.5 ' + (r.forecast ? RELEASE_TEXT[r.forecast.status] : 'text-ink-600')}><RocketIcon /></span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[12.5px] font-medium text-ink-800">{d.name}</span>
              <span className="block text-[11px] text-ink-500">
                {d.date}{d.forecastText ? ` · ${d.forecastText}` : ''}
              </span>
            </span>
          </button>
        );
      })}
    </div>,
    document.body,
  );
}

function CollapsedNotesCell(props: {
  tone: IterationTone;
  topBorder?: boolean;
  onExpand: () => void;
  notes: string[];
}) {
  const bg =
    props.tone === 'current'
      ? 'bg-amber-50/40 hover:bg-amber-100'
      : props.tone === 'past'
        ? 'bg-ink-50/70 hover:bg-ink-100'
        : 'bg-ink-50/30 hover:bg-brand-50/60';
  const hasNotes = props.notes.length > 0;
  const preview = hasNotes ? props.notes.join(' · ') : '';
  const tooltip = hasNotes
    ? `${props.notes.join('\n— — —\n')}\n\n(Click to expand)`
    : 'Iteration notes are collapsed. Click to expand.';

  return (
    <td
      className={
        'group/collapsed relative h-7 min-w-[28px] cursor-pointer border-b border-r-2 border-r-ink-300 border-ink-200 p-0 align-middle transition-colors ' +
        bg +
        (props.topBorder ? ' border-t-2' : '')
      }
      onClick={props.onExpand}
      title={tooltip}
    >
      <div
        className="pointer-events-none absolute inset-0 opacity-50"
        style={{
          backgroundImage:
            'repeating-linear-gradient(135deg, transparent 0 6px, rgba(15,23,42,0.04) 6px 7px)',
        }}
        aria-hidden
      />
      <div className="relative flex h-full w-full items-center gap-1.5 px-2.5">
        {hasNotes ? (
          <>
            <svg width="10" height="10" viewBox="0 0 12 12" className="shrink-0 text-ink-400" aria-hidden>
              <path
                d="M2 2.5a.5.5 0 0 1 .5-.5h7a.5.5 0 0 1 .5.5v7a.5.5 0 0 1-.5.5h-7a.5.5 0 0 1-.5-.5v-7Z"
                stroke="currentColor"
                strokeWidth="1"
                fill="none"
              />
              <path d="M3.5 4.5h5M3.5 6h5M3.5 7.5h3" stroke="currentColor" strokeWidth="1" strokeLinecap="round" />
            </svg>
            <span className="min-w-0 flex-1 truncate text-[11px] leading-tight text-ink-500">
              {preview}
            </span>
          </>
        ) : (
          <span
            className="inline-block h-1 w-6 rounded-full bg-ink-300/60 transition group-hover/collapsed:bg-ink-400/80"
            aria-hidden
          />
        )}
      </div>
    </td>
  );
}

function WeekNoteTextarea(props: {
  value: string;
  onChange: (text: string) => void;
  title?: string;
  compact?: boolean;
  muted?: boolean;
  onFocus?: () => void;
  onBlur?: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);

  const minH = props.compact ? 48 : 64;

  const autoGrow = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.max(el.scrollHeight, minH)}px`;
  }, [minH]);

  useEffect(() => {
    if (editing) autoGrow();
  }, [editing, props.value, autoGrow]);

  if (editing) {
    return (
      <textarea
        ref={ref}
        autoFocus
        value={props.value}
        onChange={e => props.onChange(e.target.value)}
        onInput={autoGrow}
        onFocus={props.onFocus}
        onBlur={() => {
          setEditing(false);
          props.onBlur?.();
        }}
        placeholder="Notes… (supports markdown)"
        title={props.title}
        rows={1}
        className={
          'block w-full resize-none rounded-lg border border-brand-300 bg-white px-2.5 py-2 font-mono text-[12px] leading-relaxed outline-none ring-2 ring-brand-200 transition placeholder:text-ink-300/60 ' +
          (props.muted ? 'text-ink-500' : 'text-ink-700')
        }
        style={{ overflow: 'hidden' }}
      />
    );
  }

  const hasValue = props.value.trim().length > 0;
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={e => {
        if ((e.target as HTMLElement).closest('a')) return;
        setEditing(true);
      }}
      onKeyDown={e => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          setEditing(true);
        }
      }}
      title={props.title}
      style={{ minHeight: minH }}
      className={
        'group/note block w-full cursor-text break-words rounded-lg border border-transparent px-2.5 py-2 text-[13px] leading-relaxed transition hover:border-ink-200 hover:bg-white hover:shadow-sm ' +
        (props.muted ? 'text-ink-500' : 'text-ink-700')
      }
    >
      {hasValue ? <MarkdownText text={props.value} /> : <span className="text-ink-300/60 opacity-0 transition group-hover/note:opacity-100 group-focus-visible/note:opacity-100 [@media(hover:none)]:opacity-100">Notes…</span>}
    </div>
  );
}

/* ---- tiny inline markdown renderer (no deps) ---- */

const linkClass =
  'text-brand-600 underline decoration-brand-300 underline-offset-2 hover:text-brand-700 hover:decoration-brand-500';

function MarkdownText({ text }: { text: string }) {
  const lines = text.split('\n');
  const blocks: React.ReactNode[] = [];
  let bullets: string[] | null = null;
  let nodeKey = 0;

  const flushBullets = () => {
    if (bullets && bullets.length) {
      blocks.push(
        <ul key={`ul-${nodeKey++}`} className="ml-4 list-disc space-y-0.5">
          {bullets.map((b, i) => (
            <li key={i}>{renderInline(b)}</li>
          ))}
        </ul>,
      );
    }
    bullets = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = /^\s*[-*]\s+(.*)$/.exec(line);
    if (m) {
      if (!bullets) bullets = [];
      bullets.push(m[1]);
      continue;
    }
    flushBullets();
    if (line.trim() === '') {
      blocks.push(<div key={`gap-${nodeKey++}`} className="h-2" />);
    } else {
      blocks.push(<div key={`l-${nodeKey++}`}>{renderInline(line)}</div>);
    }
  }
  flushBullets();
  return <>{blocks}</>;
}

type InlineMatch = { start: number; end: number; node: React.ReactNode };
type InlineFinder = (s: string) => InlineMatch | null;

const INLINE_FINDERS: InlineFinder[] = [
  s => {
    const m = /`([^`\n]+)`/.exec(s);
    if (!m) return null;
    return {
      start: m.index,
      end: m.index + m[0].length,
      node: <code className="rounded bg-ink-100 px-1 py-px font-mono text-[12px] text-ink-700">{m[1]}</code>,
    };
  },
  s => {
    const m = /\[([^\]\n]+)\]\((https?:\/\/[^)\s]+|mailto:[^)\s]+)\)/.exec(s);
    if (!m) return null;
    return {
      start: m.index,
      end: m.index + m[0].length,
      node: (
        <a
          href={m[2]}
          target="_blank"
          rel="noopener noreferrer"
          onClick={e => e.stopPropagation()}
          className={linkClass}
        >
          {renderInline(m[1])}
        </a>
      ),
    };
  },
  s => {
    const m = /\*\*([^*\n]+?)\*\*/.exec(s);
    if (!m) return null;
    return {
      start: m.index,
      end: m.index + m[0].length,
      node: <strong className="font-semibold">{renderInline(m[1])}</strong>,
    };
  },
  s => {
    const m = /(?<!\*)\*([^*\n]+?)\*(?!\*)/.exec(s);
    if (!m) return null;
    return {
      start: m.index,
      end: m.index + m[0].length,
      node: <em>{renderInline(m[1])}</em>,
    };
  },
  s => {
    const m = /~~([^~\n]+?)~~/.exec(s);
    if (!m) return null;
    return {
      start: m.index,
      end: m.index + m[0].length,
      node: <span className="line-through opacity-70">{renderInline(m[1])}</span>,
    };
  },
  s => {
    const m = /(https?:\/\/[^\s<>"')\]]+|www\.[^\s<>"')\]]+)/.exec(s);
    if (!m) return null;
    let url = m[1];
    while (/[.,;:!?]$/.test(url)) url = url.slice(0, -1);
    if (!url) return null;
    const href = url.startsWith('http') ? url : `https://${url}`;
    return {
      start: m.index,
      end: m.index + url.length,
      node: (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          onClick={e => e.stopPropagation()}
          className={linkClass}
        >
          {url}
        </a>
      ),
    };
  },
];

function renderInline(text: string): React.ReactNode[] {
  if (!text) return [];
  let first: InlineMatch | null = null;
  for (const find of INLINE_FINDERS) {
    const m = find(text);
    if (m && (!first || m.start < first.start)) first = m;
  }
  if (!first) return [text];
  const parts: React.ReactNode[] = [];
  if (first.start > 0) parts.push(text.slice(0, first.start));
  parts.push(<React.Fragment key={`m-${first.start}`}>{first.node}</React.Fragment>);
  if (first.end < text.length) {
    const tail = renderInline(text.slice(first.end));
    for (let i = 0; i < tail.length; i++) {
      const item = tail[i];
      parts.push(
        typeof item === 'string'
          ? item
          : <React.Fragment key={`t-${first.end}-${i}`}>{item}</React.Fragment>,
      );
    }
  }
  return parts;
}

/* ============================================================ */
/* ChartTransposed — weeks as rows, people as columns           */
/* ============================================================ */

function ChartTransposed(props: {
  state: State;
  allWeeks: WeekInfo[];
  projectsById: Record<ID, Project>;
  releasesByWeek: Record<string, ScheduledRelease[]>;
  onEditProject: (id: ID) => void;
  collapsedIterationIds: Set<ID>;
  currentIterationId: ID | null;
  currentWeekId: string | null;
  iterationToneById: Record<ID, IterationTone>;
  highlightedProjectId: ID | null;
  toggleIterationCollapsed: (id: ID) => void;
  renamePerson: (id: ID, name: string) => void;
  movePerson: (id: ID, dir: -1 | 1) => void;
  removePerson: (id: ID) => void;
  addPerson: (name?: string) => void;
  addIteration: () => void;
  removeIteration: (id: ID) => void;
  setIterationStart: (id: ID, isoDate: string) => void;
  setIterationGoal: (id: ID, goal: string) => void;
  duplicateIteration: (id: ID) => void;
  addAssignment: (personId: ID, weekId: string, projectId: ID, milestoneId?: ID) => void;
  moveAssignment: (assignmentId: ID, personId: ID, weekId: string) => void;
  setAssignmentMilestone: (assignmentId: ID, milestoneId: ID | undefined) => void;
  removeAssignment: (id: ID) => void;
  setWeekNote: (weekId: string, text: string) => void;
  onTextFocus: () => void;
  onTextBlur: () => void;
}) {
  const { state, allWeeks, projectsById } = props;
  const [picker, setPicker] = useState<{ personId: ID; weekId: string; rect: DOMRect } | null>(null);
  const iterationRows = useMemo(
    () => state.iterations.map((iter, idx) => ({
      iter,
      idx,
      tone: props.iterationToneById[iter.id] ?? 'future',
      isCollapsed: props.collapsedIterationIds.has(iter.id),
      weeks: allWeeks.filter(w => w.iterationId === iter.id),
    })),
    [allWeeks, props.collapsedIterationIds, props.iterationToneById, state.iterations],
  );
  const visibleWeeks = useMemo(
    () => iterationRows.flatMap(row => row.isCollapsed ? [] : row.weeks),
    [iterationRows],
  );
  const visibleWeekIndexById = useMemo(() => {
    const indexById: Record<string, number> = {};
    visibleWeeks.forEach((week, idx) => {
      indexById[week.id] = idx;
    });
    return indexById;
  }, [visibleWeeks]);
  const runLayout = useRunLayout(state.assignments, iterationRows, projectsById);
  const [extending, setExtending] = useState<null | {
    personId: ID;
    projectId: ID;
    milestoneId?: ID;
    fromIdx: number;
    toIdx: number;
  }>(null);

  const startExtend = (personId: ID, projectId: ID, milestoneId: ID | undefined, weekId: string) => {
    const fromIdx = visibleWeeks.findIndex(w => w.id === weekId);
    if (fromIdx === -1) return;
    setExtending({ personId, projectId, milestoneId, fromIdx, toIdx: fromIdx });
    const onMove = (e: MouseEvent) => {
      const el = (document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null)?.closest(
        '[data-cell="1"]',
      ) as HTMLElement | null;
      if (!el) return;
      if (el.dataset.pid !== personId) return;
      const idx = visibleWeeks.findIndex(w => w.id === el.dataset.wid);
      if (idx < fromIdx) return;
      setExtending(prev => (prev && prev.toIdx !== idx ? { ...prev, toIdx: idx } : prev));
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      setExtending(curr => {
        if (curr) {
          for (let i = curr.fromIdx + 1; i <= curr.toIdx; i++) {
            const w = visibleWeeks[i];
            if (w) props.addAssignment(curr.personId, w.id, curr.projectId, curr.milestoneId);
          }
        }
        return null;
      });
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  // Sticky column widths
  const ITER_W = 'var(--iteration-column-width)';
  const WEEK_W = 'var(--week-column-width)';

  return (
    <div
      className={
        'inline-block min-w-full overflow-clip rounded-2xl border border-ink-200 bg-white shadow-[0_1px_2px_rgba(15,23,42,0.04),0_8px_24px_-12px_rgba(15,23,42,0.08)] [--iteration-column-width:92px] [--week-column-width:80px] sm:[--iteration-column-width:140px] sm:[--week-column-width:96px]' +
        (Object.values(props.releasesByWeek).some(r => r.length > 0) ? ' sm:[--week-column-width:150px]' : '') +
        (extending ? ' select-none' : '')
      }
    >
      <table className="w-full border-separate border-spacing-0">
        <thead>
          <tr>
            {/* corner: iteration col */}
            <th
              data-chart-corner
              style={{ left: 0, width: ITER_W, minWidth: ITER_W }}
              className="sticky top-0 z-30 h-9 border-b border-r border-ink-200 bg-ink-50 px-2 py-2 text-left align-middle text-[10.5px] font-semibold uppercase tracking-[0.08em] text-ink-500"
            >
              Iteration
            </th>
            {/* corner: week col */}
            <th
              style={{ left: ITER_W, width: WEEK_W, minWidth: WEEK_W }}
              className="sticky top-0 z-30 h-9 border-b border-r border-ink-200 bg-ink-50 px-2 py-2 text-left align-middle text-[10.5px] font-semibold uppercase tracking-[0.08em] text-ink-500"
            >
              Week
            </th>
            {state.people.map((person, colIdx) => (
              <th
                key={person.id}
                className="group/col sticky top-0 z-20 h-9 min-w-[140px] border-b border-r border-ink-200 bg-ink-50 px-2 py-1 text-left align-middle"
              >
                <div className="flex items-center gap-1">
                  <input
                    value={person.name}
                    onChange={e => props.renamePerson(person.id, e.target.value)}
                    onFocus={props.onTextFocus}
                    onBlur={props.onTextBlur}
                    className="min-w-0 flex-1 rounded border border-transparent bg-transparent px-2 py-1 text-[12.5px] font-semibold text-ink-900 outline-none transition hover:bg-white hover:shadow-sm focus:border-ink-300 focus:bg-white focus:ring-2 focus:ring-brand-200"
                  />
                  <div className="flex opacity-0 group-hover/col:opacity-100">
                    <button
                      type="button"
                      onClick={() => props.movePerson(person.id, -1)}
                      disabled={colIdx === 0}
                      className="px-0.5 text-[9px] leading-none text-ink-400 hover:text-ink-700 disabled:invisible"
                      title="Move left"
                    >◀</button>
                    <button
                      type="button"
                      onClick={() => props.movePerson(person.id, 1)}
                      disabled={colIdx === state.people.length - 1}
                      className="px-0.5 text-[9px] leading-none text-ink-400 hover:text-ink-700 disabled:invisible"
                      title="Move right"
                    >▶</button>
                  </div>
                  <IconButton
                    danger
                    title="Remove person"
                    className="opacity-0 group-hover/col:opacity-100 focus:opacity-100"
                    onClick={() => {
                      props.removePerson(person.id);
                    }}
                  >
                    ×
                  </IconButton>
                </div>
              </th>
            ))}
            {/* + Person */}
            <th className="sticky top-0 z-20 h-9 w-10 border-b border-r border-ink-200 bg-ink-50 px-1 align-middle">
              <button
                type="button"
                onClick={() => props.addPerson()}
                title="Add person"
                className="inline-flex h-6 w-6 items-center justify-center rounded-md border border-ink-200 bg-white text-[14px] font-semibold leading-none text-ink-600 shadow-sm transition hover:border-brand-300 hover:bg-brand-50 hover:text-brand-700"
              >
                +
              </button>
            </th>
            {/* Notes col */}
            <th className="sticky top-0 z-20 h-9 w-[220px] min-w-[180px] border-b border-ink-200 bg-ink-50 px-3 align-middle text-left text-[10.5px] font-semibold uppercase tracking-[0.08em] text-ink-500">
              Notes
            </th>
          </tr>
        </thead>
        <tbody>
          {state.iterations.length === 0 && (
            <tr>
              <td
                colSpan={4 + state.people.length}
                className="px-6 py-10 text-center text-[13px] text-ink-500"
              >
                Click <span className="rounded bg-white px-1.5 py-0.5 font-medium text-ink-700 ring-1 ring-ink-200">+</span> to add 2 weeks.
              </td>
            </tr>
          )}
          {iterationRows.map(({ iter, idx: iterIdx, tone, isCollapsed, weeks }) => {
            const isCurrent = tone === 'current';
            const isPast = tone === 'past';
            const iterBg = isCurrent
              ? 'bg-amber-100 text-amber-800'
              : isPast
                ? 'bg-ink-100 text-ink-500'
                : (iterIdx % 2 === 0 ? 'bg-brand-50 text-brand-700' : 'bg-indigo-50 text-indigo-700');
            const weekBg = isCurrent
              ? 'bg-amber-50 text-amber-800'
              : isPast
                ? 'bg-ink-50 text-ink-400'
                : 'bg-[color-mix(in_srgb,var(--color-ink-50)_70%,var(--color-white))] text-ink-600';
            const iterationControls = (
              <div className="flex flex-col items-start gap-1">
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => props.toggleIterationCollapsed(iter.id)}
                    title={isCollapsed ? 'Expand iteration' : 'Collapse iteration'}
                    aria-label={isCollapsed ? 'Expand iteration' : 'Collapse iteration'}
                    className="inline-flex h-4 w-4 items-center justify-center rounded text-current opacity-60 transition hover:bg-white/50 hover:opacity-100"
                  >
                    <Chevron open={!isCollapsed} />
                  </button>
                  <span>Iter {iterIdx + 1}</span>
                  {isCurrent && (
                    <span
                      className="rounded-full bg-amber-500 px-1.5 py-px text-[8px] font-bold uppercase tracking-[0.08em] text-[#fff]"
                      title="Today is in this iteration"
                    >
                      Now
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-0.5">
                  <label
                    className={'relative inline-flex h-4 w-4 cursor-pointer items-center justify-center rounded text-current transition hover:bg-white/50 ' + ITER_REVEAL}
                    title={`Set start date (currently ${iter.startDate})`}
                  >
                    <svg width="11" height="11" viewBox="0 0 14 14" fill="none" aria-hidden>
                      <rect x="2" y="3" width="10" height="9" rx="1.5" stroke="currentColor" strokeWidth="1.3" />
                      <path d="M2 6h10" stroke="currentColor" strokeWidth="1.3" />
                      <path d="M5 2v2M9 2v2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
                    </svg>
                    <input
                      type="date"
                      value={iter.startDate}
                      onChange={e => {
                        if (e.target.value) props.setIterationStart(iter.id, e.target.value);
                      }}
                      className="absolute inset-0 cursor-pointer opacity-0"
                      aria-label="Iteration start date"
                    />
                  </label>
                  <button
                    type="button"
                    onClick={() => props.duplicateIteration(iter.id)}
                    title="Duplicate this iteration (copies all assignments to a new iteration at the end)"
                    aria-label="Duplicate iteration"
                    className={'inline-flex h-4 w-4 items-center justify-center rounded text-current transition hover:bg-white/50 ' + ITER_REVEAL}
                  >
                    <DuplicateIcon />
                  </button>
                  <button
                    onClick={() => {
                      props.removeIteration(iter.id);
                    }}
                    title="Remove iteration"
                    aria-label="Remove iteration"
                    className={'inline-flex h-4 w-4 items-center justify-center rounded text-current transition hover:bg-white/50 ' + ITER_REVEAL}
                  >
                    ×
                  </button>
                </div>
                {!isCollapsed && (
                  <IterationGoal
                    goal={iter.goal}
                    onChange={g => props.setIterationGoal(iter.id, g)}
                    onTextFocus={props.onTextFocus}
                    onTextBlur={props.onTextBlur}
                    className="max-w-[124px]"
                  />
                )}
              </div>
            );
            const compactIterationControls = (
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => props.toggleIterationCollapsed(iter.id)}
                  title={isCollapsed ? 'Expand iteration' : 'Collapse iteration'}
                  aria-label={isCollapsed ? 'Expand iteration' : 'Collapse iteration'}
                  className="inline-flex h-4 w-4 items-center justify-center rounded text-current opacity-60 transition hover:bg-white/50 hover:opacity-100"
                >
                  <Chevron open={!isCollapsed} />
                </button>
                <span>Iter {iterIdx + 1}</span>
                {isCurrent && (
                  <span
                    className="rounded-full bg-amber-500 px-1.5 py-px text-[8px] font-bold uppercase tracking-[0.08em] text-[#fff]"
                    title="Today is in this iteration"
                  >
                    Now
                  </span>
                )}
                <label
                  className={'relative ml-0.5 inline-flex h-4 w-4 cursor-pointer items-center justify-center rounded text-current transition hover:bg-white/50 ' + ITER_REVEAL}
                  title={`Set start date (currently ${iter.startDate})`}
                >
                  <svg width="11" height="11" viewBox="0 0 14 14" fill="none" aria-hidden>
                    <rect x="2" y="3" width="10" height="9" rx="1.5" stroke="currentColor" strokeWidth="1.3" />
                    <path d="M2 6h10" stroke="currentColor" strokeWidth="1.3" />
                    <path d="M5 2v2M9 2v2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
                  </svg>
                  <input
                    type="date"
                    value={iter.startDate}
                    onChange={e => {
                      if (e.target.value) props.setIterationStart(iter.id, e.target.value);
                    }}
                    className="absolute inset-0 cursor-pointer opacity-0"
                    aria-label="Iteration start date"
                  />
                </label>
                <button
                  type="button"
                  onClick={() => props.duplicateIteration(iter.id)}
                  title="Duplicate this iteration (copies all assignments to a new iteration at the end)"
                  aria-label="Duplicate iteration"
                  className={'inline-flex h-4 w-4 items-center justify-center rounded text-current transition hover:bg-white/50 ' + ITER_REVEAL}
                >
                  <DuplicateIcon />
                </button>
                <button
                  onClick={() => {
                    props.removeIteration(iter.id);
                  }}
                  title="Remove iteration"
                  aria-label="Remove iteration"
                  className={'inline-flex h-4 w-4 items-center justify-center rounded text-current transition hover:bg-white/50 ' + ITER_REVEAL}
                >
                  ×
                </button>
              </div>
            );

            if (isCollapsed) {
              return (
                <tr key={`${iter.id}:collapsed`} className="group/row">
                  <td
                    data-iter-id={iter.id}
                    style={{ left: 0, width: ITER_W, minWidth: ITER_W }}
                    className={
                      'group/iter sticky z-10 border-b border-r border-ink-200 px-2 py-1 align-middle text-[11px] font-semibold uppercase tracking-[0.06em] ' +
                      iterBg
                    }
                  >
                    {compactIterationControls}
                  </td>
                  <td
                    style={{ left: ITER_W, width: WEEK_W, minWidth: WEEK_W }}
                    className={
                      'sticky z-10 h-7 cursor-pointer border-b border-r border-ink-200 px-2 py-1 align-middle text-[10.5px] font-medium tabular-nums ' +
                      weekBg
                    }
                    onClick={() => props.toggleIterationCollapsed(iter.id)}
                    title={`Expand iteration (${iterationDateRange(iter)})`}
                  >
                    <span className="opacity-80">{iterationDateRange(iter)}</span>
                    <WeekReleases
                      releases={weeks.flatMap(w => props.releasesByWeek[w.id] ?? [])}
                      onEdit={props.onEditProject}
                    />
                  </td>
                  {state.people.map((person, colIdx) => (
                    <CollapsedIterationCell
                      key={person.id}
                      rowAlt={colIdx % 2 === 1}
                      tone={tone}
                      onExpand={() => props.toggleIterationCollapsed(iter.id)}
                      assignments={summarizeIterationAssignments(state.assignments, person.id, iter.id)}
                      projectsById={projectsById}
                      personName={person.name}
                    />
                  ))}
                  <td className={'border-b border-r border-ink-200 ' + (isCurrent ? 'bg-amber-50/40' : isPast ? 'bg-ink-50/70' : '')}></td>
                  <CollapsedNotesCell
                    tone={tone}
                    onExpand={() => props.toggleIterationCollapsed(iter.id)}
                    notes={collectIterationNotes(state.weekNotes, weeks)}
                  />
                </tr>
              );
            }

            return weeks.map((w, weekIdx) => {
              const visibleWeekIdx = visibleWeekIndexById[w.id] ?? -1;
              return (
                <tr key={w.id} className="group/row">
                  {weekIdx === 0 && (
                    <td
                      data-iter-id={iter.id}
                      rowSpan={weeks.length}
                      style={{ left: 0, width: ITER_W, minWidth: ITER_W }}
                      className={
                        'group/iter sticky z-10 border-b border-r border-ink-200 px-2 py-2 align-top text-[11px] font-semibold uppercase tracking-[0.06em] ' +
                        iterBg
                      }
                    >
                      {iterationControls}
                    </td>
                  )}
                  <td
                    style={{ left: ITER_W, width: WEEK_W, minWidth: WEEK_W }}
                    aria-current={w.id === props.currentWeekId ? 'date' : undefined}
                    className={
                      'sticky z-10 border-b border-r border-ink-200 px-2 py-2 align-top text-[11px] font-medium tabular-nums ' +
                      weekBg
                    }
                  >
                    {w.id === props.currentWeekId && <TodayDot />}
                    {w.label}
                    <WeekReleases releases={props.releasesByWeek[w.id]} onEdit={props.onEditProject} />
                  </td>
                  {state.people.map((person, colIdx) => {
                    const cellAssigns = state.assignments.filter(
                      a => a.personId === person.id && a.weekId === w.id,
                    );
                    const isDri = cellAssigns.some(
                      a => lookupProject(projectsById, a.projectId)?.driId === person.id,
                    );
                    const inExtendPreview =
                      !!extending &&
                      extending.personId === person.id &&
                      visibleWeekIdx > extending.fromIdx &&
                      visibleWeekIdx <= extending.toIdx;
                    const extendPreviewProject = inExtendPreview
                      ? lookupProject(projectsById, extending!.projectId)
                      : undefined;
                    return (
                      <Cell
                        key={person.id}
                        rowAlt={colIdx % 2 === 1}
                        personId={person.id}
                        weekId={w.id}
                        assignments={cellAssigns}
                        projectsById={projectsById}
                        isDri={isDri}
                        isIterEnd={false}
                        isCurrentWeek={isCurrent}
                        isPastWeek={isPast}
                        highlightedProjectId={props.highlightedProjectId}
                        extendPreviewProject={extendPreviewProject}
                        extendPreviewMilestone={inExtendPreview ? milestoneOf(extendPreviewProject, extending!.milestoneId) : undefined}
                        onAdd={pid => props.addAssignment(person.id, w.id, pid)}
                        onMove={aid => props.moveAssignment(aid, person.id, w.id)}
                        onRemove={props.removeAssignment}
                        onPick={rect => setPicker({ personId: person.id, weekId: w.id, rect })}
                        onStartExtend={(projectId, milestoneId) => startExtend(person.id, projectId, milestoneId, w.id)}
                        onSetMilestone={props.setAssignmentMilestone}
                        lanes={runLayout.lanesByPerson[person.id]}
                        slots={runLayout.slots}
                        vertical
                      />
                    );
                  })}
                  {/* + Person spacer cell to match header */}
                  <td className={'border-b border-r border-ink-200 ' + (isCurrent ? 'bg-amber-50/40' : isPast ? 'bg-ink-50/70' : '')}></td>
                  {/* Notes col */}
                  <td
                    className={
                      'border-b border-l border-ink-200 p-1 align-top ' +
                      (isCurrent ? 'bg-amber-50/40' : isPast ? 'bg-ink-50/70' : 'bg-white')
                    }
                  >
                    <WeekNoteTextarea
                      value={state.weekNotes?.[w.id] ?? ''}
                      onChange={text => props.setWeekNote(w.id, text)}
                      title={state.weekNotes?.[w.id] || 'Add a note for this week'}
                      compact
                      muted={isPast}
                      onFocus={props.onTextFocus}
                      onBlur={props.onTextBlur}
                    />
                  </td>
                </tr>
              );
            });
          })}
          <tr>
            <td
              colSpan={2}
              style={{ left: 0 }}
              className="sticky z-10 border-r border-ink-200 bg-ink-50 px-2 py-1.5"
            >
              <button
                type="button"
                onClick={props.addIteration}
                title="Add iteration"
                aria-label="Add iteration"
                className="inline-flex h-6 w-6 items-center justify-center rounded-md border border-ink-200 bg-white text-[14px] font-semibold leading-none text-ink-600 shadow-sm transition hover:border-brand-300 hover:bg-brand-50 hover:text-brand-700"
              >
                +
              </button>
            </td>
            <td colSpan={2 + state.people.length} />
          </tr>
        </tbody>
      </table>

      {picker && (
        <ProjectPicker
          rect={picker.rect}
          projects={state.projects.filter(p => !p.descoped)}
          onPick={(pid, milestoneId) => {
            props.addAssignment(picker.personId, picker.weekId, pid, milestoneId);
            setPicker(null);
          }}
          onClose={() => setPicker(null)}
        />
      )}
    </div>
  );
}

function Cell(props: {
  personId: ID;
  weekId: string;
  assignments: Assignment[];
  projectsById: Record<ID, Project>;
  isDri: boolean;
  isIterEnd: boolean;
  isCurrentWeek: boolean;
  isPastWeek: boolean;
  rowAlt: boolean;
  highlightedProjectId: ID | null;
  extendPreviewProject?: Project;
  extendPreviewMilestone?: Milestone;
  onAdd: (projectId: ID) => void;
  onMove: (assignmentId: ID) => void;
  onRemove: (assignmentId: ID) => void;
  onPick: (rect: DOMRect) => void;
  onStartExtend: (projectId: ID, milestoneId?: ID) => void;
  onSetMilestone: (assignmentId: ID, milestoneId: ID | undefined) => void;
  lanes?: PersonLanes;
  slots: Record<ID, RunSlot>;
  /** Weeks run down the page, so runs join top to bottom. */
  vertical?: boolean;
}) {
  const [hover, setHover] = useState(false);
  const [milestoneMenu, setMilestoneMenu] = useState<{ assignmentId: ID; rect: DOMRect } | null>(null);
  const cellRef = useRef<HTMLTableCellElement>(null);

  const onDragOver = (e: React.DragEvent) => {
    if (
      e.dataTransfer.types.includes('application/x-project') ||
      e.dataTransfer.types.includes('application/x-assignment')
    ) {
      e.preventDefault();
      e.dataTransfer.dropEffect = e.dataTransfer.types.includes('application/x-assignment') ? 'move' : 'copy';
      setHover(true);
    }
  };
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setHover(false);
    const aid = e.dataTransfer.getData('application/x-assignment');
    if (aid) return props.onMove(aid);
    const pid = e.dataTransfer.getData('application/x-project');
    if (pid) props.onAdd(pid);
  };

  const hasUnavailable = props.assignments.some(a => isUnavailable(a.projectId));

  const baseBg = hasUnavailable
    ? 'pattern-stripe-soft'
    : props.isCurrentWeek
    ? (props.rowAlt ? 'bg-amber-50/80 hover:bg-amber-50' : 'bg-amber-50/40 hover:bg-amber-50')
    : props.isPastWeek
    ? (props.rowAlt ? 'bg-ink-100/80 hover:bg-ink-100' : 'bg-ink-50/80 hover:bg-ink-100')
    : props.rowAlt
    ? 'bg-ink-50/70 hover:bg-brand-50/40'
    : 'bg-white hover:bg-brand-50/40';

  const hasHighlightedProject = props.highlightedProjectId != null &&
    props.assignments.some(a => a.projectId === props.highlightedProjectId);

  return (
    <td
      ref={cellRef}
      data-cell="1"
      data-pid={props.personId}
      data-wid={props.weekId}
      className={
        'group/cell relative min-h-[64px] min-w-[160px] cursor-pointer border-b-2 border-r border-ink-200 p-1.5 align-middle transition-colors ' +
        (props.vertical ? 'h-px ' : '') +
        baseBg +
        (props.isIterEnd ? ' border-r-2 border-r-ink-300' : '') +
        (hover ? ' !bg-brand-50 ring-2 ring-inset ring-brand-400' : '') +
        (props.extendPreviewProject ? ' ring-2 ring-inset ring-brand-400/70' : '') +
        (hasHighlightedProject && !hover ? ' ring-2 ring-inset ring-brand-500 bg-brand-50/30' : '')
      }
      onDragOver={onDragOver}
      onDragLeave={() => setHover(false)}
      onDrop={onDrop}
      onClick={() => cellRef.current && props.onPick(cellRef.current.getBoundingClientRect())}
      title="Click to add a project, or drag one in"
    >
      <div
        className={
          props.vertical && props.assignments.length > 0 && !hasUnavailable
            ? 'flex h-full min-h-[48px] flex-row items-stretch gap-1 px-0.5'
            : 'flex min-h-[48px] flex-col items-start justify-center gap-1 px-0.5'
        }
      >
        {hasUnavailable ? (
          <div className="flex w-full items-center justify-center">
            <button
              type="button"
              className="group/na inline-flex cursor-pointer items-center gap-1 rounded px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-ink-400 transition hover:bg-white/60 hover:text-ink-600"
              title="Click to remove N/A status"
              aria-label="Remove N/A status"
              onClick={e => {
                e.stopPropagation();
                const ua = props.assignments.find(a => isUnavailable(a.projectId));
                if (ua) props.onRemove(ua.id);
              }}
            >
              N/A
              <span className="text-[9px] opacity-0 group-hover/na:opacity-100 group-focus-visible/na:opacity-100" aria-hidden>×</span>
            </button>
          </div>
        ) : (
        <>
        {props.assignments.length === 0 && !props.extendPreviewProject && (
          <span
            className={
              'pointer-events-none w-full select-none text-center text-ink-300 transition ' +
              (hover
                ? 'text-[11px] italic font-medium text-brand-600 opacity-100'
                : 'text-[18px] font-light opacity-0 group-hover/cell:opacity-60')
            }
          >
            {hover ? 'drop here' : '+'}
          </span>
        )}
        {props.extendPreviewProject && (
          <span
            className={
              'pointer-events-none select-none rounded-full border border-dashed border-brand-500/70 px-2.5 py-[3px] text-[11px] font-semibold leading-none opacity-80'
            }
            style={{
              background: isPto(props.extendPreviewProject.id)
                ? 'transparent'
                : isFR(props.extendPreviewProject.id)
                ? '#fef3c7'
                : props.extendPreviewProject.color,
              color: isPto(props.extendPreviewProject.id) || isFR(props.extendPreviewProject.id)
                ? 'var(--color-ink-600)'
                : inkFor(props.extendPreviewProject.color),
            }}
          >
            {props.extendPreviewProject.name}
            {props.extendPreviewMilestone && (
              <span className="font-medium opacity-80"> · {milestoneLabel(props.extendPreviewMilestone)}</span>
            )}
          </span>
        )}
        {(() => {
          const renderChip = (a: Assignment) => {
            const proj = lookupProject(props.projectsById, a.projectId);
            if (!proj) return null;
            const milestone = milestoneOf(proj, a.milestoneId);
            const openUrl = milestone?.url ?? proj.url;
            const slot = props.slots[a.id];
            return (
              <AssignChip
                key={a.id}
                project={proj}
                milestone={milestone}
                onOpenMilestones={proj.milestones?.length
                  ? rect => setMilestoneMenu({ assignmentId: a.id, rect })
                  : undefined}
                isPto={isPto(a.projectId)}
                isFR={isFR(a.projectId)}
                isUnavailable={isUnavailable(a.projectId)}
                muted={props.isPastWeek || (props.highlightedProjectId != null && props.highlightedProjectId !== a.projectId)}
                joinPrev={slot?.joinPrev}
                joinNext={slot?.joinNext}
                vertical={props.vertical}
                onDragStart={e => {
                  e.dataTransfer.setData('application/x-assignment', a.id);
                  e.dataTransfer.effectAllowed = 'move';
                }}
                onClick={e => {
                  e.stopPropagation();
                  if (openUrl) window.open(openUrl, '_blank', 'noopener,noreferrer');
                }}
                onRemove={() => props.onRemove(a.id)}
                onStartExtend={() => props.onStartExtend(a.projectId, milestone?.id)}
              />
            );
          };
          const laneCount = props.lanes?.count ?? 0;
          if (props.assignments.length === 0 || laneCount === 0) return props.assignments.map(renderChip);
          // Every cell in a person's row (or column) draws the same lanes, so runs line up.
          const lanes: (Assignment | undefined)[] = Array.from({ length: laneCount }, () => undefined);
          const unplaced: Assignment[] = [];
          for (const a of props.assignments) {
            const lane = props.slots[a.id]?.lane;
            if (lane != null && lane < laneCount && !lanes[lane]) lanes[lane] = a;
            else unplaced.push(a);
          }
          return (
            <>
              {lanes.map((a, i) => (
                <div
                  key={i}
                  className={
                    props.vertical
                      ? 'flex min-w-0 flex-1 flex-col justify-center'
                      : 'flex w-full items-center ' + (props.lanes?.tall[i] ? 'h-[34px]' : 'h-[22px]')
                  }
                >
                  {a && renderChip(a)}
                </div>
              ))}
              {unplaced.map(renderChip)}
            </>
          );
        })()}
        </>
        )}
      </div>
      {milestoneMenu && (() => {
        const a = props.assignments.find(x => x.id === milestoneMenu.assignmentId);
        const proj = a && lookupProject(props.projectsById, a.projectId);
        if (!a || !proj?.milestones?.length) return null;
        return (
          <MilestoneMenu
            rect={milestoneMenu.rect}
            project={proj}
            currentId={milestoneOf(proj, a.milestoneId)?.id}
            onPick={milestoneId => {
              props.onSetMilestone(a.id, milestoneId);
              setMilestoneMenu(null);
            }}
            onClose={() => setMilestoneMenu(null)}
          />
        );
      })()}
    </td>
  );
}

function AssignChip(props: {
  project: Project;
  milestone?: Milestone;
  /** Present when the project has milestones the assignment can be pointed at. */
  onOpenMilestones?: (rect: DOMRect) => void;
  isPto?: boolean;
  isFR?: boolean;
  isUnavailable?: boolean;
  muted?: boolean;
  /** Continues the same work from the previous / into the next visible week. */
  joinPrev?: boolean;
  joinNext?: boolean;
  vertical?: boolean;
  onDragStart: (e: React.DragEvent) => void;
  onClick: (e: React.MouseEvent) => void;
  onRemove: () => void;
  onStartExtend: () => void;
}) {
  const { project, isPto: pto, isFR: fr, isUnavailable: unavail, joinPrev, joinNext, vertical } = props;
  const isSentinelChip = pto || fr || unavail;
  const ink = isSentinelChip ? 'var(--color-ink-700)' : undefined;
  const joined = !!(joinPrev || joinNext);
  const twoLine = !!props.milestone && !isSentinelChip;
  // Joined segments reach past the cell padding so a run reads as one bar.
  const runClass = vertical
    ? (joined ? ' flex-1 self-stretch !items-start' : ' self-start') +
      (joinPrev ? ' rounded-t-none border-t-0' : '') +
      (joinNext ? ' rounded-b-none border-b-0' : '')
    : (twoLine ? ' h-full' : ' h-[22px]') +
      (joinPrev ? ' rounded-l-none border-l-0' : '') +
      (joinNext ? ' rounded-r-none border-r-0' : '');
  const runStyle: React.CSSProperties = vertical
    ? { marginTop: joinPrev ? -6 : undefined, marginBottom: joinNext ? -6 : undefined }
    : joined
    ? {
        marginLeft: joinPrev ? -8 : undefined,
        marginRight: joinNext ? -8 : undefined,
        width: `calc(100% + ${(joinPrev ? 8 : 0) + (joinNext ? 8 : 0)}px)`,
        maxWidth: 'none',
      }
    : {};
  const baseClass =
    'group/chip relative inline-flex max-w-full min-w-0 cursor-grab items-center gap-1 rounded-md px-2.5 py-[3px] pr-3 text-left text-[11px] font-semibold leading-tight transition-[filter] active:cursor-grabbing hover:brightness-95' +
    runClass;
  const chipStyle: React.CSSProperties = isSentinelChip
    ? { ...runStyle, color: ink }
    : ({
        ...runStyle,
        ['--cc' as string]: project.color,
        ['--cc-dark' as string]: darkBgFor(project.color),
      } as React.CSSProperties);
  const mutedStyle: React.CSSProperties = props.muted
    ? { ...chipStyle, filter: 'saturate(0.55)', opacity: 0.72 }
    : chipStyle;
  return (
    <span
      draggable
      onDragStart={props.onDragStart}
      data-run-cont={joinPrev || undefined}
      onClick={props.onClick}
      title={
        pto
          ? 'PTO'
          : fr
          ? 'First responder duty'
          : unavail
          ? 'Not available'
          : project.name +
            (props.milestone ? ` · ${milestoneLabel(props.milestone)}` : '') +
            ((props.milestone?.url ?? project.url) ? `\nClick to open ${props.milestone?.url ?? project.url}` : '') +
            (props.onOpenMilestones ? '\nUse ◆ to pick a milestone' : '')
      }
      className={
        baseClass +
        ' ' +
        (pto
          ? 'border border-dashed border-ink-400/60 pattern-stripe-soft-rev uppercase tracking-[0.06em]'
          : fr
          ? 'border border-amber-400/70 bg-amber-100 uppercase tracking-[0.06em]'
          : unavail
          ? 'border border-ink-400/60 bg-ink-300 uppercase tracking-[0.06em]'
          : 'chip-tint border shadow-[0_1px_2px_rgba(15,23,42,0.04)]') +
        ((props.milestone?.url ?? project.url) && !isSentinelChip ? ' cursor-pointer' : '')
      }
      style={mutedStyle}
    >
      <span
        className={
          'run-label flex min-w-0 items-center gap-1' +
          (joined ? (vertical ? ' sticky top-10 self-start' : ' sticky left-[136px] sm:left-[208px]') : '')
        }
        aria-hidden={joinPrev || undefined}
      >
      {pto ? (
        <span className="inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center text-[10px]" aria-hidden>
          ☀
        </span>
      ) : fr ? (
        <span className="inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center text-[10px] text-amber-700" aria-hidden>
          ⚡
        </span>
      ) : unavail ? (
        <span className="inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center text-[10px]" aria-hidden>
          ∅
        </span>
      ) : null}
      {twoLine && props.milestone ? (
        <span className="flex min-w-0 flex-col leading-tight">
          <span className="truncate">{project.name}</span>
          <span className="flex min-w-0 items-center gap-1 text-[10px] font-medium opacity-80">
            <span className="inline-block h-1.5 w-1.5 shrink-0 rotate-45 rounded-[1px] bg-current opacity-70" aria-hidden />
            <span className="truncate">{milestoneLabel(props.milestone)}</span>
          </span>
        </span>
      ) : (
        <span className="min-w-0 truncate leading-tight">
          {fr ? 'FR' : project.name}
        </span>
      )}
      </span>
      {joinPrev && <span className="flex-1" aria-hidden />}
      {props.onOpenMilestones && !isSentinelChip && (
        <button
          type="button"
          aria-label={props.milestone ? 'Change milestone' : 'Pick a milestone'}
          title={props.milestone ? 'Change milestone' : 'Pick a milestone'}
          onMouseDown={e => e.stopPropagation()}
          onClick={e => {
            e.stopPropagation();
            props.onOpenMilestones!((e.currentTarget as HTMLElement).getBoundingClientRect());
          }}
          className="-my-0.5 ml-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] opacity-0 transition group-hover/chip:opacity-60 focus-visible:opacity-100 focus-visible:outline focus-visible:outline-2 hover:!opacity-100 hover:bg-black/15"
        >
          ◆
        </button>
      )}
      <span
        onClick={e => {
          e.stopPropagation();
          props.onRemove();
        }}
        className="ml-0.5 inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full text-[10px] font-bold opacity-0 transition group-hover/chip:opacity-60 hover:!opacity-100 hover:bg-black/15"
      >
        ×
      </span>
      {/* Run end handle: drag to extend this assignment across consecutive weeks */}
      {!joinNext && <span
        onMouseDown={e => {
          // Suppress native HTML5 drag (the chip itself is draggable for moves)
          // and the cell-click that would open the picker, then start extend.
          e.preventDefault();
          e.stopPropagation();
          props.onStartExtend();
        }}
        onClick={e => e.stopPropagation()}
        onDragStart={e => e.preventDefault()}
        title="Drag right to extend across more weeks"
        className="absolute right-0 top-0 z-10 flex h-full w-2 cursor-col-resize items-center justify-center opacity-0 transition group-hover/chip:opacity-100"
      >
        <span
          className="block h-3 w-[2px] rounded-full bg-current opacity-60"
          aria-hidden
        />
      </span>}
    </span>
  );
}

/* ============================================================ */
/* Projects table                                                */
/* ============================================================ */

type SortKey = 'name' | 'estimated' | 'planned';
type SortDir = 'asc' | 'desc';

function ProjectsTable(props: {
  projects: Project[];
  people: Person[];
  peopleById: Record<ID, Person>;
  plannedByProject: Record<ID, number>;
  weeksPerEM: number;
  updateProject: (id: ID, p: Partial<Project>) => void;
  removeProject: (id: ID) => void;
  compact?: boolean;
  editingId: ID | null;
  onStartEdit: (id: ID) => void;
  onStopEdit: () => void;
  highlightedProjectId: ID | null;
  onToggleHighlight: (id: ID) => void;
}) {
  const [sortKey, setSortKey] = useState<SortKey | null>(null);
  const [sortDir, setSortDir] = useState<SortDir>('asc');
  const [search, setSearch] = useState('');

  const filteredProjects = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return props.projects;
    return props.projects.filter(p => {
      if (p.name.toLowerCase().includes(q)) return true;
      if (p.url && p.url.toLowerCase().includes(q)) return true;
      return false;
    });
  }, [props.projects, search]);

  const sortedProjects = useMemo(() => {
    if (!sortKey) return filteredProjects;
    const arr = [...filteredProjects];
    const dir = sortDir === 'asc' ? 1 : -1;
    arr.sort((a, b) => {
      let av: number | string;
      let bv: number | string;
      if (sortKey === 'name') {
        av = a.name.toLowerCase();
        bv = b.name.toLowerCase();
      } else if (sortKey === 'estimated') {
        av = a.estimateEM ?? -Infinity;
        bv = b.estimateEM ?? -Infinity;
      } else {
        av = props.plannedByProject[a.id] ?? 0;
        bv = props.plannedByProject[b.id] ?? 0;
      }
      if (av < bv) return -1 * dir;
      if (av > bv) return 1 * dir;
      return 0;
    });
    return arr;
  }, [filteredProjects, props.plannedByProject, sortKey, sortDir]);

  const totals = useMemo(() => {
    let plannedWeeks = 0;
    let estimatedEM = 0;
    for (const p of props.projects) {
      plannedWeeks += props.plannedByProject[p.id] ?? 0;
      if (typeof p.estimateEM === 'number') estimatedEM += p.estimateEM;
    }
    const plannedEM = props.weeksPerEM > 0 ? plannedWeeks / props.weeksPerEM : 0;
    return { plannedEM, estimatedEM };
  }, [props.projects, props.plannedByProject, props.weeksPerEM]);

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir(d => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir(key === 'name' ? 'asc' : 'desc');
    }
  };

  const arrow = (key: SortKey) => {
    if (sortKey !== key) return <span className="ml-1 text-ink-300">↕</span>;
    return <span className="ml-1 text-brand-600">{sortDir === 'asc' ? '↑' : '↓'}</span>;
  };

  const sortBtn = (label: string, key: SortKey, extra?: React.ReactNode) => (
    <button
      type="button"
      onClick={() => toggleSort(key)}
      className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-ink-500 hover:bg-ink-100"
    >
      {label}
      {extra}
      {arrow(key)}
    </button>
  );

  return (
    <div className="flex flex-col">
      <div className="sticky top-0 z-10 flex flex-wrap items-center gap-2 border-b border-ink-200 bg-ink-50/80 px-3 py-2 backdrop-blur">
        <div className="relative">
          <input
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search projects…"
            aria-label="Search projects"
            className="h-7 w-44 rounded-md border border-ink-200 bg-white pl-7 pr-6 text-[12px] text-ink-700 placeholder:text-ink-400 outline-none transition focus:border-brand-400 focus:ring-2 focus:ring-brand-200"
          />
          <svg
            width="12"
            height="12"
            viewBox="0 0 14 14"
            className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-ink-400"
            aria-hidden
          >
            <circle cx="6" cy="6" r="3.75" stroke="currentColor" strokeWidth="1.3" fill="none" />
            <path d="M9 9l3 3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
          </svg>
          {search && (
            <button
              type="button"
              onClick={() => setSearch('')}
              title="Clear search"
              aria-label="Clear search"
              className="absolute right-1 top-1/2 inline-flex h-4 w-4 -translate-y-1/2 items-center justify-center rounded text-ink-400 hover:bg-ink-100 hover:text-ink-700"
            >
              ×
            </button>
          )}
        </div>
        <span className="text-[10.5px] font-semibold uppercase tracking-[0.08em] text-ink-500">Sort:</span>
        {sortBtn('Project', 'name')}
        {sortBtn('Est.', 'estimated', totals.estimatedEM > 0 && (
          <span className="ml-0.5 normal-case tracking-normal text-ink-400">· {fmtWk(totals.estimatedEM)} EM</span>
        ))}
        {sortBtn('Planned', 'planned', (
          <span className="ml-0.5 normal-case tracking-normal text-ink-400">
            · {fmtWk(totals.plannedEM)}{totals.estimatedEM > 0 ? ` / ${fmtWk(totals.estimatedEM)}` : ''} EM
          </span>
        ))}
      </div>
      {sortedProjects.length === 0 && (
        <div className="px-6 py-12 text-center">
          <div className="mx-auto max-w-sm text-ink-500">
            {search.trim() ? (
              <>
                <div className="mb-2 text-[20px]">🔍</div>
                <div className="text-[13px]">No projects match <span className="font-semibold text-ink-700">“{search.trim()}”</span>.</div>
                <button
                  type="button"
                  onClick={() => setSearch('')}
                  className="mt-3 inline-flex items-center rounded-md border border-ink-200 bg-white px-2.5 py-1 text-[11.5px] font-medium text-ink-600 hover:border-brand-300 hover:text-brand-700"
                >
                  Clear search
                </button>
              </>
            ) : (
              <>
                <div className="mb-2 text-[20px]">🗂️</div>
                <div className="text-[13px]">No projects yet. Click <span className="rounded bg-ink-100 px-1.5 py-0.5 font-semibold">+ Add project</span> above to create one.</div>
              </>
            )}
          </div>
        </div>
      )}
      <div className="flex flex-col">
        {sortedProjects.map(p => (
          <ProjectRow
            key={p.id}
            project={p}
            people={props.people}
            peopleById={props.peopleById}
            planned={props.plannedByProject[p.id] ?? 0}
            weeksPerEM={props.weeksPerEM}
            onStartEdit={() => props.onStartEdit(p.id)}
            onUpdate={patch => props.updateProject(p.id, patch)}
            onRemove={() => {
              if (props.editingId === p.id) props.onStopEdit();
              props.removeProject(p.id);
            }}
            compact={!!props.compact}
            isHighlighted={props.highlightedProjectId === p.id}
            onToggleHighlight={() => props.onToggleHighlight(p.id)}
          />
        ))}
      </div>
    </div>
  );
}

function ProjectRow(props: {
  project: Project;
  people: Person[];
  peopleById: Record<ID, Person>;
  planned: number;
  weeksPerEM: number;
  onStartEdit: () => void;
  onUpdate: (patch: Partial<Project>) => void;
  onRemove: () => void;
  compact: boolean;
  isHighlighted: boolean;
  onToggleHighlight: () => void;
}) {
  const { project, planned, weeksPerEM } = props;
  const [colorOpen, setColorOpen] = useState(false);
  const swatchRef = useRef<HTMLSpanElement>(null);
  const [colorRect, setColorRect] = useState<DOMRect | null>(null);

  const onChipDragStart = (e: React.DragEvent) => {
    e.dataTransfer.setData('application/x-project', project.id);
    e.dataTransfer.effectAllowed = 'copy';
  };

  const est = project.estimateEM;
  const plannedEM = weeksPerEM > 0 ? planned / weeksPerEM : 0;
  let badgeClass = 'bg-ink-100 text-ink-500 border-ink-200';
  let badgeText = fmtWk(plannedEM);
  if (est != null && est > 0) {
    badgeText = `${fmtWk(plannedEM)} / ${fmtWk(est)}`;
    if (plannedEM > est + 0.01) badgeClass = 'bg-rose-50 text-rose-700 border-rose-200 font-semibold';
    else if (Math.abs(plannedEM - est) <= 0.01) badgeClass = 'bg-emerald-50 text-emerald-700 border-emerald-200 font-semibold';
    else badgeClass = 'bg-ink-100 text-ink-700 border-ink-200';
  } else if (plannedEM === 0) {
    badgeClass = 'bg-transparent text-ink-400 border-transparent';
  }

  const ink = inkFor(project.color);
  const dri = project.driId ? props.peopleById[project.driId] : null;

  const chip = (
    <>
      <span
        ref={swatchRef}
        draggable
        onDragStart={onChipDragStart}
        onClick={e => {
          e.stopPropagation();
          if (swatchRef.current) setColorRect(swatchRef.current.getBoundingClientRect());
          setColorOpen(true);
        }}
        title="Drag onto a cell to assign · Click to change color"
        className="inline-flex h-7 w-10 shrink-0 cursor-grab items-center justify-center rounded-full border shadow-[inset_0_1px_0_rgba(255,255,255,0.6),0_1px_2px_rgba(15,23,42,0.06)] transition hover:-translate-y-px hover:shadow-md active:cursor-grabbing"
        style={{ background: project.color, color: ink, borderColor: 'rgba(15,23,42,0.08)' }}
      >
        <span className="text-[9px] tracking-tighter opacity-50">⋮⋮</span>
      </span>
      {colorOpen && colorRect && (
        <ColorPopover
          rect={colorRect}
          value={project.color}
          onPick={c => { props.onUpdate({ color: c }); setColorOpen(false); }}
          onClose={() => setColorOpen(false)}
        />
      )}
    </>
  );

  const plannedBadge = (
    <span
      className={'inline-flex shrink-0 items-center gap-1 rounded-full border px-2.5 py-[3px] text-[12px] tabular-nums ' + badgeClass}
      title={est != null && est > 0 ? `${fmtWk(plannedEM)} planned / ${fmtWk(est)} estimated EM` : 'Planned EM across all assignments'}
    >
      {badgeText} <span className="text-[10.5px] opacity-70">EM</span>
    </span>
  );

  const driBadge = dri ? (
    <span
      className="inline-flex shrink-0 items-center gap-1 rounded-full border border-ink-200 bg-white px-2.5 py-[3px] text-[12px] text-ink-700"
      title={`DRI: ${dri.name}`}
    >
      <span className="rounded bg-amber-100 px-1 text-[9px] font-bold uppercase tracking-wide text-amber-700">DRI</span>
      {dri.name}
    </span>
  ) : (
    <span
      className="inline-flex shrink-0 items-center gap-1 rounded-full border border-dashed border-ink-200 bg-transparent px-2.5 py-[3px] text-[12px] text-ink-400"
      title="No DRI assigned"
    >
      No DRI
    </span>
  );

  const editBtn = (
    <button
      type="button"
      onClick={e => { e.stopPropagation(); props.onStartEdit(); }}
      title="Edit project"
      className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md border border-ink-200 bg-white px-2 text-[12px] text-ink-600 transition hover:bg-ink-50 hover:text-ink-800"
    >
      ✎ Edit
    </button>
  );

  const deleteBtn = (
    <IconButton danger title="Delete project" onClick={e => { e.stopPropagation(); props.onRemove(); }}>×</IconButton>
  );

  const titleNode = project.url ? (
    <a
      href={project.url}
      target="_blank"
      rel="noopener noreferrer"
      onClick={e => e.stopPropagation()}
      className="block truncate text-[13px] font-semibold text-ink-900 hover:text-brand-700 hover:underline"
      title={`Open ${project.url}`}
    >
      {project.name || 'Untitled project'}
    </a>
  ) : (
    <span className="block truncate text-[13px] font-semibold text-ink-900">{project.name || 'Untitled project'}</span>
  );

  return (
    <div
      className={
        'group/row border-b border-ink-100 cursor-pointer transition ' +
        (props.isHighlighted
          ? 'bg-brand-50 ring-2 ring-inset ring-brand-400'
          : 'hover:bg-ink-50/60')
      }
      onClick={props.onToggleHighlight}
      title={props.isHighlighted ? 'Click to clear highlight' : 'Click to highlight this project in the chart'}
    >
      {props.compact ? (
        <div className="flex items-center gap-2 px-3 py-2.5">
          {chip}
          <div className="min-w-0 flex-1">
            {titleNode}
            <div className="mt-1 flex flex-wrap items-center gap-1.5">
              {driBadge}
              {plannedBadge}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {editBtn}
            {deleteBtn}
          </div>
        </div>
      ) : (
        <div className="flex items-center gap-3 px-4 py-2.5">
          {chip}
          <div className="min-w-0 flex-1">{titleNode}</div>
          {driBadge}
          {plannedBadge}
          {editBtn}
          {deleteBtn}
        </div>
      )}
    </div>
  );
}

function MilestoneMenu(props: {
  rect: DOMRect;
  project: Project;
  currentId?: ID;
  onPick: (milestoneId: ID | undefined) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const { onClose } = props;
  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  const milestones = props.project.milestones ?? [];
  const w = 260;
  const h = Math.min(320, 64 + (milestones.length + 1) * 30);
  let top = props.rect.bottom + 4;
  let left = props.rect.left - 8;
  if (top + h > window.innerHeight) top = props.rect.top - h - 4;
  if (left + w > window.innerWidth) left = window.innerWidth - w - 8;
  if (left < 8) left = 8;

  const option = (id: ID | undefined, label: string, extra?: React.ReactNode) => {
    const selected = props.currentId === id;
    return (
      <button
        key={id ?? '__none__'}
        role="menuitemradio"
        aria-checked={selected}
        onClick={e => { e.stopPropagation(); props.onPick(id); }}
        className={
          'flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[12.5px] transition hover:bg-ink-100 ' +
          (selected ? 'bg-brand-50 font-semibold text-ink-900' : 'text-ink-700')
        }
      >
        <span className="w-3 shrink-0 text-center text-[11px] text-brand-600" aria-hidden>{selected ? '✓' : ''}</span>
        <span className={'truncate' + (id ? '' : ' italic text-ink-500')}>{label}</span>
        {extra}
      </button>
    );
  };

  return (
    <div
      ref={ref}
      role="menu"
      aria-label={`Milestones of ${props.project.name}`}
      onClick={e => e.stopPropagation()}
      className="anim-pop-in fixed z-50 flex flex-col overflow-hidden rounded-xl border border-ink-200 bg-white shadow-2xl"
      style={{ top, left, width: w, maxHeight: h }}
    >
      <div className="flex items-center gap-2 border-b border-ink-200 bg-ink-50/60 px-3 py-2">
        <span className="inline-block h-3 w-3 shrink-0 rounded-full border border-black/5" style={{ background: props.project.color }} />
        <span className="truncate text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-500">{props.project.name}</span>
      </div>
      <div className="flex-1 overflow-y-auto p-1.5">
        {option(undefined, 'Whole project')}
        {milestones.map(m => option(
          m.id,
          milestoneLabel(m),
          m.releaseDate ? (
            <span className="ml-auto shrink-0 pl-2 text-[10.5px] font-normal tabular-nums text-ink-400">
              {parseISODate(m.releaseDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
            </span>
          ) : null,
        ))}
      </div>
    </div>
  );
}

function ProjectPicker(props: {
  rect: DOMRect;
  projects: Project[];
  onPick: (id: ID, milestoneId?: ID) => void;
  onClose: () => void;
}) {
  const [q, setQ] = useState('');
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) props.onClose();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') props.onClose(); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [props]);

  const needle = q.trim().toLowerCase();
  const filtered = props.projects.flatMap(p => {
    const milestones = p.milestones ?? [];
    if (p.name.toLowerCase().includes(needle)) return [{ project: p, milestones }];
    const matching = milestones.filter(m => m.name.toLowerCase().includes(needle));
    return matching.length ? [{ project: p, milestones: matching }] : [];
  });

  const w = 280;
  const h = 340;
  let top = props.rect.bottom + 6;
  let left = props.rect.left;
  if (top + h > window.innerHeight) top = props.rect.top - h - 6;
  if (left + w > window.innerWidth) left = window.innerWidth - w - 8;

  return (
    <div
      ref={ref}
      className="anim-pop-in fixed z-50 flex flex-col overflow-hidden rounded-xl border border-ink-200 bg-white shadow-2xl"
      style={{ top, left, width: w, maxHeight: h }}
    >
      <div className="border-b border-ink-200 bg-ink-50/60 px-3 py-2">
        <input
          autoFocus
          placeholder="Filter projects…"
          value={q}
          onChange={e => setQ(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter' && filtered[0]) {
              const { project, milestones } = filtered[0];
              props.onPick(project.id, project.name.toLowerCase().includes(needle) ? undefined : milestones[0]?.id);
            }
          }}
          className="w-full rounded-md border border-ink-200 bg-white px-2.5 py-1.5 text-[13px] outline-none focus:border-brand-400 focus:ring-2 focus:ring-brand-200"
        />
      </div>
      <div className="flex-1 overflow-y-auto p-1.5">
        {filtered.length === 0 && props.projects.length > 0 && (
          <div className="px-3 py-6 text-center text-[12px] text-ink-500">No projects match.</div>
        )}
        {props.projects.length === 0 && (
          <div className="px-3 py-4 text-center text-[12px] text-ink-500">
            No projects yet — add one in the Projects panel below.
          </div>
        )}
        {filtered.map(({ project: p, milestones }) => (
          <div key={p.id}>
            <button
              className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-[13px] text-ink-800 transition hover:bg-ink-100"
              onClick={() => props.onPick(p.id)}
              title={milestones.length ? `${p.name} (no specific milestone)` : p.name}
            >
              <span
                className="inline-block h-3.5 w-3.5 shrink-0 rounded-full border border-black/5"
                style={{ background: p.color }}
              />
              <span className="truncate">{p.name}</span>
            </button>
            {milestones.map(m => (
              <button
                key={m.id}
                className="group/ms flex w-full items-center gap-2 rounded-md py-1 pl-[30px] pr-2.5 text-left text-[12px] text-ink-600 transition hover:bg-ink-100 hover:text-ink-900"
                onClick={() => props.onPick(p.id, m.id)}
                title={`${p.name} · ${milestoneLabel(m)}`}
              >
                <span
                  className="inline-block h-2 w-2 shrink-0 rotate-45 rounded-[1px] border border-black/10"
                  style={{ background: p.color }}
                  aria-hidden
                />
                <span className="truncate">{milestoneLabel(m)}</span>
                {m.releaseDate && (
                  <span className="ml-auto shrink-0 pl-2 text-[10.5px] tabular-nums text-ink-400">
                    {parseISODate(m.releaseDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                  </span>
                )}
              </button>
            ))}
          </div>
        ))}
      </div>
      <div className="flex gap-1 border-t border-ink-200 p-1.5">
        {SENTINEL_PICKS.map(opt => (
          <button
            key={opt.id}
            type="button"
            className="flex flex-1 items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-600 transition hover:bg-ink-100"
            onClick={() => props.onPick(opt.id)}
            title={opt.title}
          >
            {opt.swatch}
            {opt.label}
          </button>
        ))}
      </div>
    </div>
  );
}

const SENTINEL_PICKS: { id: ID; label: string; title: string; swatch: React.ReactNode }[] = [
  {
    id: PTO_ID,
    label: 'PTO',
    title: 'Mark this week as PTO (not a project)',
    swatch: <span className="inline-block h-3 w-3 rounded-full border border-ink-300/70 pattern-stripe-dense" aria-hidden />,
  },
  {
    id: FR_ID,
    label: 'FR',
    title: 'Mark this week as first-responder (on-call) duty',
    swatch: (
      <span className="inline-flex h-3 w-3 items-center justify-center rounded-full border border-amber-400/80 bg-amber-100 text-[7px] text-amber-700" aria-hidden>
        ⚡
      </span>
    ),
  },
  {
    id: UNAVAILABLE_ID,
    label: 'N/A',
    title: 'Mark this person as not available this week',
    swatch: <span className="inline-block h-3 w-3 rounded-full border border-ink-400/70 bg-ink-300" aria-hidden />,
  },
];
