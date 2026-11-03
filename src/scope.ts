/** Scope tracking for projects whose URL is a GitHub issue.
 *
 *  A snapshot is one complete observation of the issue's sub-issue tree.
 *  Everything the UI shows — scope history, changes, creep, and forecasts —
 *  is derived from the snapshot list, so demo data and real GitHub data go
 *  through the same rules. */

export type GitHubIssueRef = { owner: string; repo: string; number: number; url: string };

const ISSUE_URL = /^https?:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/issues\/(\d+)\/?(?:[?#].*)?$/i;

/** Only GitHub issue URLs are tracked; repos, PRs, and other links are ignored. */
export function parseGitHubIssueUrl(url: string | undefined): GitHubIssueRef | null {
  const m = url?.trim().match(ISSUE_URL);
  if (!m) return null;
  const [, owner, repo, num] = m;
  return { owner, repo, number: Number(num), url: `https://github.com/${owner}/${repo}/issues/${num}` };
}

/** Matches the same issue across URLs that differ only in case or suffix. */
export const issueKey = (ref: { owner: string; repo: string; number: number }) =>
  `${ref.owner}/${ref.repo}#${ref.number}`.toLowerCase();

export type CloseReason = 'completed' | 'not_planned' | 'duplicate';

export type ScopeIssue = {
  /** Stable GitHub node ID. Numbers and titles are display-only. */
  id: string;
  number: number;
  title: string;
  url: string;
  /** GitHub issue type; only Batch issues are milestone containers. */
  issueType?: string | null;
  /** Immediate parent: the tracked issue's ID for direct sub-issues. */
  parentId: string;
  state: 'open' | 'closed';
  closeReason?: CloseReason;
  /** Previous parent, when the issue was moved here from another issue. */
  movedFrom?: { number: number; title: string };
  /** Size from the project board's Points field; DEFAULT_POINTS when unset. */
  points?: number | null;
};

/** Points for an issue whose Points field is empty or not a number. */
export const DEFAULT_POINTS = 3;
export const pointsOf = (issue: Pick<ScopeIssue, 'points'>) =>
  typeof issue.points === 'number' && issue.points > 0 ? issue.points : DEFAULT_POINTS;
const sumPoints = (issues: Iterable<ScopeIssue>) => {
  let n = 0;
  for (const i of issues) n += pointsOf(i);
  return n;
};

export type ScopeSnapshot = {
  observedAt: string;
  /** Every issue below the tracked issue, at any depth, in GitHub's order.
   *  May also include unrelated issues, such as sibling milestones, as context. */
  issues: ScopeIssue[];
};

/** Pace of a finished milestone, used to estimate milestones that just started. */
export type ReferencePace = {
  /** Short name like "M2", or the issue number. */
  label: string;
  number: number;
  completionRate: number;
  creepRate: number;
  /** From the first finished issue to the last. */
  weeks: number;
};

export type ScopeTracking = {
  source: 'demo' | 'github';
  root: { id: string; number: number };
  /** Complete observations, oldest first. */
  snapshots: ScopeSnapshot[];
  /** Last successful refresh; newer than the last snapshot when nothing changed. */
  checkedAt: string;
  /** Most recent failed refresh after `checkedAt`. */
  refreshError?: { at: string; message: string };
  /** Finished sibling milestones, for estimating a milestone tracked on its own. */
  reference?: ReferencePace[];
  /** Data-quality notes to show with the results. */
  warnings?: string[];
};

export type ScopeLoad =
  | { status: 'ready'; tracking: ScopeTracking }
  /** GitHub returns 404 for both missing issues and issues we can't read. */
  | { status: 'unreadable'; at: string };

const DAY = 86_400_000;
const WEEK = 7 * DAY;

/** Rates come from this trailing window. */
export const FORECAST_WINDOW_DAYS = 28;
/** Weeks after work starts until a milestone's own pace fully replaces finished milestones' pace. */
export const RAMP_WEEKS = 4;
/** With no finished milestone to compare with, no forecast until work has run this long… */
export const MIN_HISTORY_DAYS = 7;
/** …and this many points were finished. */
export const MIN_COMPLETIONS = 5;
/** New points per finished point at which creep counts as high. */
export const HIGH_CREEP_RATIO = 0.5;
/** Projections further out are reported without a date. */
const MAX_PROJECTION_WEEKS = 52;

export const ALL_VIEW = 'all';

export type ScopeEvent = {
  at: string;
  kind: 'added' | 'removed' | 'completed' | 'reopened' | 'split';
  issue: ScopeIssue;
  note?: string;
  /** Additions: where the issue came from. */
  origin?: 'new' | 'moved' | 'split';
  /** Removals: why the issue left. */
  reason?: 'moved' | 'dropped' | 'unlinked';
  /** Removals and splits: the issue was still open, so remaining work went down. */
  wasOpen?: boolean;
};

/** Creep is newly discovered work: new open issues, not splits or moves between milestones. */
export const isCreep = (e: ScopeEvent) =>
  e.kind === 'added' && e.origin === 'new' && e.issue.state === 'open';

export type ScopePoint = { at: string; scope: number; completed: number };

export type OwnPace = {
  windowStart: string;
  windowWeeks: number;
  /** Finished minus reopened. */
  completed: number;
  creep: number;
  movedOut: number;
  dropped: number;
  completionRate: number;
  creepRate: number;
};

export type PaceScenario = { label: string; completionRate: number; creepRate: number };

export type Pace = {
  /** This milestone's observed pace; null before work starts. */
  own: OwnPace | null;
  /** Share of the estimate that comes from this milestone's own pace (0–1). */
  ownWeight: number;
  /** Finished milestones blended into the estimate. */
  references: ReferencePace[];
  /** One estimate per finished milestone, or just this milestone's own pace. */
  scenarios: PaceScenario[];
  /** Medians of the scenarios. */
  completionRate: number;
  creepRate: number;
};

export type ForecastStatus =
  | 'empty'
  | 'done'
  | 'not-started'
  | 'just-started'
  | 'too-early'
  | 'no-progress'
  | 'not-converging'
  | 'converging';

/** Statuses that come with a finish estimate. */
export const canForecast = (status: ForecastStatus) =>
  status === 'converging' || status === 'not-converging' || status === 'just-started' || status === 'not-started';

export type RemainingIssue = { issue: ScopeIssue; addedAt?: string; origin?: ScopeEvent['origin']; note?: string };

export type ScopeSummary = {
  asOf: string;
  /** When the first issue was finished; null if none has been. */
  startedAt: string | null;
  /** When the last remaining issue was finished. */
  finishedAt: string | null;
  weeksSinceStart: number;
  /** Starts at the baseline. */
  points: ScopePoint[];
  /** Scope just before the first issue was finished; current scope if work hasn't started. */
  baseline: ScopePoint;
  current: ScopePoint;
  remaining: number;
  addedSinceStart: number;
  removedSinceStart: number;
  /** Changes after the baseline, newest first. */
  events: ScopeEvent[];
  /** Issues added after the baseline first (newest first), then baseline issues. */
  remainingIssues: RemainingIssue[];
  status: ForecastStatus;
  pace: Pace | null;
  /** At least HIGH_CREEP_RATIO new issues per finished issue, once past the first weeks. */
  highCreep: boolean;
};

export type ScopeView = {
  id: string;
  label: string;
  /** The milestone issue; null for the single view of a non-epic. */
  issue: ScopeIssue | null;
  summary: ScopeSummary;
};

export type ScopeAnalysis = {
  views: ScopeView[];
  /** The tracked issue is an epic: one view per milestone, no combined view. */
  hasBreakdown: boolean;
  defaultViewId: string;
  /** Epics only: finished milestones' pace. */
  reference: ReferencePace[];
  /** Epics only: sub-issues that aren't in any milestone. */
  outside: { total: number; open: number } | null;
};

export type Projection = { weeks: number; date: string | null };

export type FinishForecast = {
  /** From the median rates. Null when new work arrives at least as fast as work is finished. */
  central: Projection | null;
  fastest: Projection | null;
  /** Null when some scenario never finishes. */
  slowest: Projection | null;
  /** Estimates come from several finished milestones. */
  isRange: boolean;
};

type Indexed = {
  at: number;
  observedAt: string;
  byId: Map<string, ScopeIssue>;
  /** IDs of issues that have sub-issues (rollups). */
  parents: Set<string>;
};

type Member = (issue: ScopeIssue, snap: Indexed) => boolean;

const index = (s: ScopeSnapshot): Indexed => ({
  at: Date.parse(s.observedAt),
  observedAt: s.observedAt,
  byId: new Map(s.issues.map(i => [i.id, i])),
  parents: new Set(s.issues.map(i => i.parentId)),
});

const iso = (ms: number) => new Date(ms).toISOString();

const isoDay = (ms: number) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const parseDay = (s: string) => {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d).getTime();
};

const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

const outOfScope = (i: ScopeIssue) =>
  i.state === 'closed' && (i.closeReason === 'not_planned' || i.closeReason === 'duplicate');

const closedLabel = (i: ScopeIssue) => (i.closeReason === 'duplicate' ? 'duplicate' : 'not planned');

/** "M4" for milestone-style titles ("M4: …", "… Milestone 4: …"), otherwise the issue number. */
export function shortLabel(issue: { number: number; title: string }): string {
  const m = issue.title.match(/\bM(?:ilestone)?\s*(\d+)\b/i);
  return m ? `M${m[1]}` : `#${issue.number}`;
}

/** A leading bracketed tag, like "[3232 M1]" in "[3232 M1] Code Security risk assessment". */
const TITLE_TAG = /^\[([^\]]*)\]\s*(?:[:\-–—]\s*)?/;

/** Words shared by the start of every list, keeping at least `keep` words in each. */
function commonLeadingWords(lists: string[][], keep: number, accept: (count: number) => boolean = () => true): number {
  let common = 0;
  while (
    lists.every(w => w.length >= common + 1 + keep && w[common].toLowerCase() === lists[0][common].toLowerCase())
  ) common++;
  while (common > 0 && !accept(common)) common--;
  return common;
}

/** Whether dropping these words leaves every bracket or parenthesis they open closed. */
function balanced(words: string[]): boolean {
  let depth = 0;
  for (const ch of words.join(' ')) {
    if (ch === '[' || ch === '(') depth++;
    else if (ch === ']' || ch === ')') depth--;
    if (depth < 0) return false;
  }
  return depth === 0;
}

/** Display names for an epic's milestones: "Milestone 4" shortened to "M4", and
 *  words every milestone title starts with (like the epic's name) dropped.
 *  Leading tags such as "[3232 M1]" lose only their shared words ("M1: …"), and
 *  dropped words never split a bracketed or parenthesized group. */
export function milestoneNames(titles: string[]): string[] {
  const short = titles.map(t => t.replace(/\bMilestone\s+(\d+)\b/i, 'M$1').trim());
  if (short.length < 2) return short;

  const tagged = short.map(t => {
    const m = t.match(TITLE_TAG);
    return m ? { tag: m[1].trim().split(/\s+/).filter(Boolean), rest: t.slice(m[0].length).trim() } : null;
  });
  if (tagged.every(x => x !== null)) {
    const parts = tagged as { tag: string[]; rest: string }[];
    const common = commonLeadingWords(parts.map(p => p.tag), 0);
    return parts.map(({ tag, rest }, i) => {
      const left = tag.slice(common).join(' ');
      if (!left) return rest || short[i];
      return rest ? `${left}: ${rest}` : left;
    });
  }

  const words = short.map(t => t.split(/\s+/));
  const common = commonLeadingWords(words, 1, n => balanced(words[0].slice(0, n)));
  return words.map(w => w.slice(common).join(' '));
}

function isInside(issue: ScopeIssue, snap: Indexed, rootId: string): boolean {
  let cur: ScopeIssue | undefined = issue;
  for (let depth = 0; cur && depth < 32; depth++) {
    if (cur.parentId === rootId) return true;
    cur = snap.byId.get(cur.parentId);
  }
  return false;
}

/** The direct sub-issue of the tracked issue that contains `issue`. */
function topLevelId(issue: ScopeIssue, snap: Indexed, rootId: string): string | null {
  let cur = issue;
  for (let depth = 0; depth < 32; depth++) {
    if (cur.parentId === rootId) return cur.id;
    const parent = snap.byId.get(cur.parentId);
    if (!parent) return null;
    cur = parent;
  }
  return null;
}

/** Name of the outermost known issue containing `issue`, e.g. the milestone it sits in. */
function containerLabel(issue: ScopeIssue, snap: Indexed): string {
  let parent = snap.byId.get(issue.parentId);
  if (!parent) return 'the tracked issue';
  for (let depth = 0; depth < 32; depth++) {
    const up = snap.byId.get(parent.parentId);
    if (!up) break;
    parent = up;
  }
  return shortLabel(parent);
}

/** Counting rule: leaf issues only (rollups would double-count their children),
 *  excluding issues closed as not planned or duplicate. */
function scopeOf(snap: Indexed, member: Member): Map<string, ScopeIssue> {
  const out = new Map<string, ScopeIssue>();
  for (const issue of snap.byId.values()) {
    if (snap.parents.has(issue.id) || outOfScope(issue) || !member(issue, snap)) continue;
    out.set(issue.id, issue);
  }
  return out;
}

function diff(
  prev: Indexed,
  cur: Indexed,
  before: Map<string, ScopeIssue>,
  after: Map<string, ScopeIssue>,
): ScopeEvent[] {
  const at = cur.observedAt;
  const events: ScopeEvent[] = [];
  // In-scope leaves that gained sub-issues were decomposed, not removed.
  const split = new Set([...before.keys()].filter(id => cur.parents.has(id)));
  const splitAncestor = (issue: ScopeIssue): ScopeIssue | undefined => {
    let parent = cur.byId.get(issue.parentId);
    for (let depth = 0; parent && depth < 32; depth++) {
      if (split.has(parent.id)) return parent;
      parent = cur.byId.get(parent.parentId);
    }
    return undefined;
  };

  for (const [id, issue] of after) {
    const was = before.get(id);
    if (was) {
      if (was.state === 'open' && issue.state === 'closed') events.push({ at, kind: 'completed', issue });
      else if (was.state === 'closed' && issue.state === 'open') events.push({ at, kind: 'reopened', issue });
      continue;
    }
    const prior = prev.byId.get(id);
    const splitFrom = splitAncestor(issue);
    if (splitFrom) {
      events.push({ at, kind: 'added', issue, origin: 'split', note: `From #${splitFrom.number}` });
    } else if (prior && outOfScope(prior)) {
      events.push({ at, kind: 'added', issue, origin: 'new', note: `Reopened after being closed as ${closedLabel(prior)}` });
    } else if (prior && !prev.parents.has(id)) {
      events.push({ at, kind: 'added', issue, origin: 'moved', note: `From ${containerLabel(prior, prev)}` });
    } else if (!prior && issue.movedFrom) {
      events.push({ at, kind: 'added', issue, origin: 'moved', note: `From ${shortLabel(issue.movedFrom)}` });
    } else {
      events.push({
        at,
        kind: 'added',
        issue,
        origin: 'new',
        note: issue.state === 'closed' ? 'Already closed when added' : undefined,
      });
    }
  }

  for (const [id, was] of before) {
    if (after.has(id)) continue;
    const wasOpen = was.state === 'open';
    const now = cur.byId.get(id);
    if (now && split.has(id)) {
      const parts = [...after.values()].filter(i => splitAncestor(i)?.id === id).length;
      events.push({ at, kind: 'split', issue: now, note: `Into ${parts} sub-issues`, wasOpen });
    } else if (now && outOfScope(now)) {
      events.push({ at, kind: 'removed', issue: now, reason: 'dropped', note: `Closed as ${closedLabel(now)}`, wasOpen });
    } else if (now) {
      events.push({ at, kind: 'removed', issue: now, reason: 'moved', note: `To ${containerLabel(now, cur)}`, wasOpen });
    } else {
      events.push({ at, kind: 'removed', issue: was, reason: 'unlinked', note: 'No longer a sub-issue', wasOpen });
    }
  }
  return events;
}

/** Finished points, minus reopened issues and finished ones later marked not planned or duplicate. */
function netCompleted(events: ScopeEvent[]): number {
  let n = 0;
  for (const e of events) {
    if (e.kind === 'completed') n += pointsOf(e.issue);
    else if (e.kind === 'reopened' || (e.kind === 'removed' && e.reason === 'dropped' && !e.wasOpen)) n -= pointsOf(e.issue);
  }
  return n;
}

function observe(events: ScopeEvent[], startedAt: number, asOf: number): OwnPace {
  const windowStart = Math.max(startedAt, asOf - FORECAST_WINDOW_DAYS * DAY);
  const recent = events.filter(e => Date.parse(e.at) >= windowStart);
  const count = (pred: (e: ScopeEvent) => boolean) => sumPoints(recent.filter(pred).map(e => e.issue));
  const windowWeeks = Math.max(1 / 7, (asOf - windowStart) / WEEK);
  const completed = netCompleted(recent);
  const creep = count(isCreep);
  return {
    windowStart: iso(windowStart),
    windowWeeks,
    completed,
    creep,
    movedOut: count(e => e.kind === 'removed' && e.reason === 'moved' && !!e.wasOpen),
    dropped: count(e => e.kind === 'removed' && e.reason === 'dropped' && !!e.wasOpen),
    completionRate: Math.max(0, completed) / windowWeeks,
    creepRate: creep / windowWeeks,
  };
}

/** Mixes a milestone's own pace with each finished milestone's pace. Early on, own
 *  rates come from less than RAMP_WEEKS of history but are weighted by elapsed time,
 *  so a few early completions count as if spread over the full ramp. */
function blend(own: OwnPace | null, ownWeight: number, refs: ReferencePace[]): Pace {
  const useRefs = refs.length > 0 && ownWeight < 1;
  const mix = (mine: number, theirs: number) => ownWeight * mine + (1 - ownWeight) * theirs;
  const scenarios: PaceScenario[] = useRefs
    ? refs.map(r => ({
        label: r.label,
        completionRate: mix(own?.completionRate ?? 0, r.completionRate),
        creepRate: mix(own?.creepRate ?? 0, r.creepRate),
      }))
    : [{ label: 'This milestone', completionRate: own?.completionRate ?? 0, creepRate: own?.creepRate ?? 0 }];
  return {
    own,
    ownWeight: useRefs ? ownWeight : 1,
    references: useRefs ? refs : [],
    scenarios,
    completionRate: median(scenarios.map(s => s.completionRate)),
    creepRate: median(scenarios.map(s => s.creepRate)),
  };
}

function summarize(snaps: Indexed[], member: Member, asOf: number, refs: ReferencePace[]): ScopeSummary {
  const scopes = snaps.map(s => scopeOf(s, member));
  const all: ScopePoint[] = snaps.map((s, i) => ({
    at: s.observedAt,
    scope: sumPoints(scopes[i].values()),
    completed: sumPoints([...scopes[i].values()].filter(issue => issue.state === 'closed')),
  }));
  const last = all.length - 1;
  const current = all[last];
  const remaining = current.scope - current.completed;
  const firstDone = all.findIndex(p => p.completed > 0);
  // Baseline: the scope just before the first issue was finished. Earlier changes are planning.
  const b = firstDone === -1 ? last : Math.max(0, firstDone - 1);
  const startedAt = firstDone === -1 ? null : all[firstDone].at;

  const ascending: ScopeEvent[] = [];
  for (let i = b + 1; i <= last; i++) ascending.push(...diff(snaps[i - 1], snaps[i], scopes[i - 1], scopes[i]));

  const baselineScope = scopes[b];
  const currentScope = scopes[last];
  const lastAdded = new Map<string, ScopeEvent>();
  for (const e of ascending) if (e.kind === 'added') lastAdded.set(e.issue.id, e);
  const remainingIssues: RemainingIssue[] = [...currentScope.values()]
    .filter(issue => issue.state === 'open')
    .map(issue => {
      if (baselineScope.has(issue.id)) return { issue };
      const e = lastAdded.get(issue.id);
      return { issue, addedAt: e?.at, origin: e?.origin, note: e?.note };
    })
    .sort((x, y) =>
      x.addedAt && y.addedAt ? y.addedAt.localeCompare(x.addedAt) || x.issue.number - y.issue.number
        : x.addedAt ? -1
        : y.addedAt ? 1
        : x.issue.number - y.issue.number,
    );

  let finishedAt: string | null = null;
  if (current.scope > 0 && remaining === 0) {
    let lastOpen = -1;
    all.forEach((p, i) => { if (p.scope > p.completed) lastOpen = i; });
    finishedAt = all[Math.min(last, lastOpen + 1)].at;
  }

  const weeksSinceStart = startedAt ? (asOf - Date.parse(startedAt)) / WEEK : 0;
  let status: ForecastStatus;
  let pace: Pace | null = null;
  let highCreep = false;
  if (current.scope === 0) {
    status = 'empty';
  } else if (remaining === 0) {
    status = 'done';
  } else if (!startedAt) {
    status = 'not-started';
    if (refs.length > 0) pace = blend(null, 0, refs);
  } else {
    const own = observe(ascending, Date.parse(startedAt), asOf);
    const ramp = Math.min(1, weeksSinceStart / RAMP_WEEKS);
    if (ramp < 1 && refs.length > 0) {
      status = 'just-started';
      pace = blend(own, ramp, refs);
    } else {
      pace = blend(own, 1, []);
      if (ramp < 1 && (weeksSinceStart * 7 < MIN_HISTORY_DAYS || own.completed < MIN_COMPLETIONS)) status = 'too-early';
      else if (own.completed <= 0 && own.creep === 0) status = 'no-progress';
      else if (own.completionRate <= own.creepRate) status = 'not-converging';
      else status = 'converging';
      if (status !== 'too-early') {
        highCreep = own.completionRate > 0
          ? own.creepRate / own.completionRate >= HIGH_CREEP_RATIO
          : own.creepRate > 0;
      }
    }
  }

  return {
    asOf: iso(asOf),
    startedAt,
    finishedAt,
    weeksSinceStart,
    points: all.slice(b),
    baseline: all[b],
    current,
    remaining,
    addedSinceStart: sumPoints([...currentScope.values()].filter(i => !baselineScope.has(i.id))),
    removedSinceStart: sumPoints([...baselineScope.values()].filter(i => !currentScope.has(i.id))),
    events: ascending.reverse(),
    remainingIssues,
    status,
    pace,
    highCreep,
  };
}

function referencePace(milestone: ScopeIssue, s: ScopeSummary): ReferencePace | null {
  if (!s.startedAt || !s.finishedAt) return null;
  const weeks = Math.max(1, (Date.parse(s.finishedAt) - Date.parse(s.startedAt)) / WEEK);
  const finished = netCompleted(s.events);
  return {
    label: shortLabel(milestone),
    number: milestone.number,
    completionRate: Math.max(0, finished) / weeks,
    creepRate: sumPoints(s.events.filter(isCreep).map(e => e.issue)) / weeks,
    weeks,
  };
}

const IN_PROGRESS: ForecastStatus[] = ['converging', 'not-converging', 'just-started'];
const ACTIVE: ForecastStatus[] = [...IN_PROGRESS, 'too-early', 'no-progress'];

/** For an epic with Batch sub-issues, one view per
 *  milestone; a combined forecast would mix finished, active, and unstarted work.
 *  Otherwise, a single view of the whole tree. */
export function analyzeScope(t: ScopeTracking): ScopeAnalysis {
  const indexed = t.snapshots.map(index);
  const rootId = t.root.id;
  const inside: Member = (issue, snap) => isInside(issue, snap, rootId);
  const firstWithScope = indexed.findIndex(s => [...s.byId.values()].some(i => inside(i, s)));
  const snaps = firstWithScope > 0 ? indexed.slice(firstWithScope) : indexed;
  if (snaps.length === 0) {
    return { views: [], hasBreakdown: false, defaultViewId: ALL_VIEW, reference: [], outside: null };
  }
  const asOf = Math.max(Date.parse(t.checkedAt), snaps[snaps.length - 1].at);
  const latest = snaps[snaps.length - 1];

  const groups = new Map<string, ScopeIssue>();
  for (const s of snaps) {
    for (const issue of s.byId.values()) {
      if (issue.parentId === rootId && issue.issueType === 'Batch') groups.set(issue.id, issue);
    }
  }
  const groupOf = (issue: ScopeIssue, snap: Indexed) => {
    const top = topLevelId(issue, snap, rootId);
    return top && groups.has(top) ? top : null;
  };
  const latestLeaves = [...scopeOf(latest, inside).values()].filter(issue => !groups.has(issue.id));
  if (groups.size === 0) {
    const summary = summarize(snaps, inside, asOf, t.reference ?? []);
    return {
      views: [{ id: ALL_VIEW, label: 'All sub-issues', issue: null, summary }],
      hasBreakdown: false,
      defaultViewId: ALL_VIEW,
      reference: [],
      outside: null,
    };
  }

  // Keep GitHub's sub-issue order from the latest observation.
  const order = [...latest.byId.keys()];
  const position = (id: string) => {
    const i = order.indexOf(id);
    return i === -1 ? order.length : i;
  };
  const milestones = [...groups.values()].sort((a, b) => position(a.id) - position(b.id));
  const snapsFor = (g: ScopeIssue) => snaps.slice(Math.max(0, snaps.findIndex(s => s.byId.has(g.id))));
  const memberOf = (g: ScopeIssue): Member => (issue, snap) => issue.id !== g.id && groupOf(issue, snap) === g.id;

  // Finished milestones set the pace for ones that just started.
  const firstPass = milestones.map(g => ({ g, summary: summarize(snapsFor(g), memberOf(g), asOf, []) }));
  const reference = firstPass
    .filter(x => x.summary.status === 'done')
    .map(x => referencePace(x.g, x.summary))
    .filter((r): r is ReferencePace => r !== null);
  const views: ScopeView[] = firstPass.map(({ g, summary }) => ({
    id: g.id,
    label: g.title,
    issue: g,
    summary: summary.status === 'done' ? summary : summarize(snapsFor(g), memberOf(g), asOf, reference),
  }));

  const outsideLeaves = latestLeaves.filter(issue => !groupOf(issue, latest));
  const defaultView = views.find(v => IN_PROGRESS.includes(v.summary.status))
    ?? views.find(v => ACTIVE.includes(v.summary.status))
    ?? views.find(v => v.summary.status !== 'done')
    ?? views[0];
  return {
    views,
    hasBreakdown: true,
    defaultViewId: defaultView.id,
    reference,
    outside: outsideLeaves.length
      ? { total: outsideLeaves.length, open: outsideLeaves.filter(i => i.state === 'open').length }
      : null,
  };
}

function projection(remaining: number, netRate: number, asOf: number): Projection | null {
  if (netRate <= 1e-9) return null;
  const weeks = remaining / netRate;
  return { weeks, date: weeks > MAX_PROJECTION_WEEKS ? null : isoDay(asOf + weeks * WEEK) };
}

/** Finish estimate with creep scaled by `multiplier` (0 = no more new issues, 1 = current rate). */
export function projectFinish(s: ScopeSummary, multiplier: number): FinishForecast | null {
  if (!s.pace || !canForecast(s.status) || s.remaining === 0) return null;
  const asOf = Date.parse(s.asOf);
  const project = (completionRate: number, creepRate: number) =>
    projection(s.remaining, completionRate - multiplier * creepRate, asOf);
  const each = s.pace.scenarios.map(sc => project(sc.completionRate, sc.creepRate));
  const finite = each.filter((p): p is Projection => p !== null).sort((a, b) => a.weeks - b.weeks);
  return {
    central: project(s.pace.completionRate, s.pace.creepRate),
    fastest: finite[0] ?? null,
    slowest: finite.length === each.length ? finite[finite.length - 1] : null,
    isRange: each.length > 1,
  };
}

/** Highest creep rate at which the remaining work still finishes by the end of `target`.
 *  Negative means it misses even with no new scope. Null without a started forecast,
 *  or once the target has passed. */
export function maxCreepForTarget(s: ScopeSummary, target: string): number | null {
  if (!s.pace || !canForecast(s.status) || s.status === 'not-started') return null;
  const weeksLeft = (parseDay(target) + DAY - Date.parse(s.asOf)) / WEEK;
  if (weeksLeft <= 0) return null;
  return s.pace.completionRate - s.remaining / weeksLeft;
}

export type TargetStatus = 'on-track' | 'at-risk' | 'late';

const mondayOf = (ms: number) => {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d.getTime();
};

/** How unfinished work compares with its target date (YYYY-MM-DD), at the current creep rate.
 *  Late once the target has passed, or when the forecast finishes after the target's week.
 *  At risk when only some estimates miss, or it finishes a few days late in the same week.
 *  Null when there's nothing to compare. */
export function targetStatus(s: ScopeSummary, target: string | undefined): TargetStatus | null {
  if (!target || s.status === 'done' || s.status === 'empty') return null;
  if (parseDay(target) + DAY <= Date.parse(s.asOf)) return 'late';
  if (s.status === 'not-started') return null;
  const f = projectFinish(s, 1);
  if (!f) return null;
  const late = (p: Projection | null) => !p || !p.date || p.date > target;
  if (f.isRange) return late(f.fastest) ? 'late' : late(f.slowest) ? 'at-risk' : 'on-track';
  if (!late(f.central)) return 'on-track';
  return f.central?.date && mondayOf(parseDay(f.central.date)) === mondayOf(parseDay(target)) ? 'at-risk' : 'late';
}

export type ReleaseForecast = {
  status: TargetStatus;
  /** Monday (YYYY-MM-DD) of the week work is forecast to finish, as the milestone table
   *  shows it; the earliest week for a range. Null when there's no finish in sight. */
  finishWeek: string | null;
  /** Monday of the latest forecast week, when a range spans several weeks. */
  finishWeekEnd?: string;
};

/** How a release card's work tracks against its ship date. A milestone card uses its
 *  epic's milestone with the same issue URL; a project card uses the whole issue, unless
 *  it's an epic, which has no combined forecast. */
export function releaseForecast(
  a: ScopeAnalysis,
  milestoneUrl: string | undefined,
  target: string,
): ReleaseForecast | null {
  let view: ScopeView | undefined;
  if (milestoneUrl) {
    const ref = parseGitHubIssueUrl(milestoneUrl);
    if (!ref || !a.hasBreakdown) return null;
    view = a.views.find(v => {
      const vRef = v.issue ? parseGitHubIssueUrl(v.issue.url) : null;
      return vRef !== null && issueKey(vRef) === issueKey(ref);
    });
  } else if (!a.hasBreakdown) {
    view = a.views[0];
  }
  if (!view) return null;
  const status = targetStatus(view.summary, target);
  if (!status) return null;
  const f = projectFinish(view.summary, 1);
  const week = (p: Projection | null | undefined) => (p?.date ? isoDay(mondayOf(parseDay(p.date))) : null);
  const finishWeek = week(f?.isRange ? f.fastest : f?.central);
  const finishWeekEnd = f?.isRange && finishWeek ? week(f.slowest) : null;
  return finishWeekEnd && finishWeekEnd !== finishWeek ? { status, finishWeek, finishWeekEnd } : { status, finishWeek };
}

/** Changes with repeats per issue collapsed to the net change: a finish undone by a
 *  reopen (or the reverse), or an add undone by a removal, drops both. Newest first. */
export function netChanges(events: ScopeEvent[]): ScopeEvent[] {
  const opposite = (a: ScopeEvent['kind'], b: ScopeEvent['kind']) =>
    (a === 'completed' && b === 'reopened') || (a === 'reopened' && b === 'completed')
    || (a === 'added' && b === 'removed') || (a === 'removed' && b === 'added');
  const kept: (ScopeEvent | null)[] = [];
  const byIssue = new Map<string, number[]>();
  for (const e of [...events].reverse()) {
    const mine = byIssue.get(e.issue.id) ?? [];
    byIssue.set(e.issue.id, mine);
    const prev = mine.length ? kept[mine[mine.length - 1]] : null;
    if (prev && opposite(prev.kind, e.kind)) {
      kept[mine.pop()!] = null;
    } else {
      mine.push(kept.length);
      kept.push(e);
    }
  }
  return kept.filter((e): e is ScopeEvent => e !== null).reverse();
}

/* ---------- GitHub history ---------- */

export type HistoryEvent =
  | { t: 'add' | 'remove'; at: string; id: string }
  | { t: 'close'; at: string; reason: CloseReason }
  | { t: 'reopen'; at: string }
  | { t: 'unparent'; at: string; parent: { id: string; number: number; title: string } };

export type HistoryIssue = {
  id: string;
  number: number;
  title: string;
  url: string;
  issueType?: string | null;
  createdAt: string;
  state: 'open' | 'closed';
  closeReason?: CloseReason;
  closedAt?: string;
  /** Current sub-issues, in GitHub's order. */
  children: string[];
  /** Sub-issues added and removed, closes and reopens, and moves away from other parents. */
  events: HistoryEvent[];
  /** Current Points value; null when unset, undefined in data cached before points were read. */
  points?: number | null;
};

/** GitHub's record of an issue tree, as fetched by the server. */
export type ScopeHistory = {
  fetchedAt: string;
  /** The tracked issue. */
  root: { id: string; number: number };
  /** Top of the fetched tree: the tracked issue, or its parent epic for context. */
  contextId: string;
  issues: HistoryIssue[];
  /** Current sub-issues the server's token can't read. */
  unreadable: number;
  /** False when the token can't read the project board, so every issue uses DEFAULT_POINTS. */
  pointsReadable?: boolean;
};

/** Whether the tracked issue is closed as completed. Not planned and duplicate closures aren't done. */
export function issueCompleted(h: ScopeHistory): boolean {
  const root = h.issues.find(i => i.id === h.root.id);
  return root?.state === 'closed' && root.closeReason === 'completed';
}

/** Changes this close together are one observation, so moving an issue between
 *  milestones reads as a move rather than a removal and a separate addition. */
const SAME_CHANGE_MS = 60_000;
/** A close reason changed this soon after closing replaces the original. */
const REASON_FIX_MS = 10 * 60_000;

type Membership = { parent: string; from: number; to: number; inferred: boolean };
type StateChange = { at: number; state: 'open' | 'closed'; reason?: CloseReason };

const countOf = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Rebuilds snapshots from GitHub's history: a snapshot for each moment the tree
 *  or an issue's state changed. Membership comes from "sub-issue added/removed"
 *  records; when GitHub has none for a current sub-issue, it counts from the
 *  issue's creation and a warning says so. */
export function trackingFromHistory(
  h: ScopeHistory,
  checkedAt: string,
  refreshError?: { at: string; message: string },
): ScopeTracking {
  const byId = new Map(h.issues.map(i => [i.id, i]));
  const fetchedAt = Date.parse(h.fetchedAt);
  const created = (id: string) => {
    const issue = byId.get(id);
    return issue ? Date.parse(issue.createdAt) : 0;
  };
  const at = (e: { at: string }) => Date.parse(e.at);

  const memberships = new Map<string, Membership[]>();
  const addMembership = (child: string, m: Membership) => {
    const list = memberships.get(child) ?? [];
    list.push(m);
    memberships.set(child, list);
  };
  for (const p of h.issues) {
    const open = new Map<string, number>();
    const changes = p.events
      .filter((e): e is Extract<HistoryEvent, { t: 'add' | 'remove' }> => e.t === 'add' || e.t === 'remove')
      .sort((a, b) => at(a) - at(b));
    for (const e of changes) {
      if (e.t === 'add') {
        if (!open.has(e.id)) open.set(e.id, at(e));
        continue;
      }
      const from = open.get(e.id);
      addMembership(e.id, {
        parent: p.id,
        from: from ?? Math.max(created(e.id), created(p.id)),
        to: at(e),
        inferred: from === undefined,
      });
      open.delete(e.id);
    }
    const current = new Set(p.children);
    for (const [child, from] of open) {
      // No longer a sub-issue but GitHub has no removal record: ends when observed.
      addMembership(child, { parent: p.id, from, to: current.has(child) ? Infinity : fetchedAt, inferred: !current.has(child) });
    }
    for (const child of p.children) {
      if (!open.has(child)) {
        addMembership(child, { parent: p.id, from: Math.max(created(child), created(p.id)), to: Infinity, inferred: true });
      }
    }
  }
  // An issue has one parent at a time; trust the later record where they overlap.
  for (const list of memberships.values()) {
    list.sort((a, b) => a.from - b.from);
    for (let i = 0; i + 1 < list.length; i++) list[i].to = Math.min(list[i].to, list[i + 1].from);
  }

  const states = new Map<string, StateChange[]>();
  for (const issue of h.issues) {
    const list: StateChange[] = [{ at: Date.parse(issue.createdAt), state: 'open' }];
    const changes = issue.events
      .filter(e => e.t === 'close' || e.t === 'reopen')
      .sort((a, b) => at(a) - at(b));
    for (const e of changes) {
      const prev = list[list.length - 1];
      if (e.t === 'close') {
        if (prev.state === 'closed' && at(e) - prev.at <= REASON_FIX_MS) prev.reason = e.reason;
        else list.push({ at: at(e), state: 'closed', reason: e.reason });
      } else if (prev.state === 'closed') {
        list.push({ at: at(e), state: 'open' });
      }
    }
    const last = list[list.length - 1];
    if (last.state !== issue.state || (issue.state === 'closed' && last.reason !== issue.closeReason)) {
      // Where the history is incomplete, GitHub's current state wins.
      const when = issue.state === 'closed' && issue.closedAt ? Date.parse(issue.closedAt) : fetchedAt;
      list.push({ at: Math.max(when, last.at), state: issue.state, reason: issue.closeReason });
    }
    states.set(issue.id, list);
  }
  const stateAt = (id: string, t: number): StateChange => {
    const list = states.get(id) ?? [];
    for (let i = list.length - 1; i >= 0; i--) if (list[i].at <= t) return list[i];
    return list[0] ?? { at: t, state: 'open' };
  };

  const movedFrom = (id: string, m: Membership): ScopeIssue['movedFrom'] => {
    let found: ScopeIssue['movedFrom'];
    for (const e of byId.get(id)?.events ?? []) {
      if (e.t !== 'unparent' || e.parent.id === m.parent) continue;
      const t = at(e);
      if (t <= m.from + SAME_CHANGE_MS && t >= m.from - REASON_FIX_MS) found = { number: e.parent.number, title: e.parent.title };
    }
    return found;
  };

  // Children in GitHub's current order, then former children by when they joined.
  const childrenOf = new Map<string, { child: string; m: Membership }[]>();
  for (const [child, list] of memberships) {
    for (const m of list) {
      const entries = childrenOf.get(m.parent) ?? [];
      entries.push({ child, m });
      childrenOf.set(m.parent, entries);
    }
  }
  for (const [parent, entries] of childrenOf) {
    const order = byId.get(parent)?.children ?? [];
    const rank = (id: string) => {
      const i = order.indexOf(id);
      return i === -1 ? order.length : i;
    };
    entries.sort((a, b) => rank(a.child) - rank(b.child) || a.m.from - b.m.from);
  }

  const times: number[] = [];
  for (const list of memberships.values()) {
    for (const m of list) {
      times.push(m.from);
      if (Number.isFinite(m.to)) times.push(m.to);
    }
  }
  for (const list of states.values()) for (const s of list.slice(1)) times.push(s.at);
  times.sort((a, b) => a - b);
  const moments: number[] = [];
  for (const t of times) {
    if (!Number.isFinite(t)) continue;
    if (moments.length > 0 && t - moments[moments.length - 1] <= SAME_CHANGE_MS) moments[moments.length - 1] = t;
    else moments.push(t);
  }

  const cache = new Map<string, ScopeIssue>();
  const issueAt = (info: HistoryIssue, parentId: string, s: StateChange, from: ScopeIssue['movedFrom']) => {
    const key = `${info.id}|${parentId}|${s.state}|${s.reason ?? ''}|${from?.number ?? ''}`;
    let issue = cache.get(key);
    if (!issue) {
      issue = {
        id: info.id,
        number: info.number,
        title: info.title,
        issueType: info.issueType,
        url: info.url,
        points: info.points ?? null,
        parentId,
        state: s.state,
        ...(s.state === 'closed' ? { closeReason: s.reason ?? 'completed' } : {}),
        ...(from ? { movedFrom: from } : {}),
      };
      cache.set(key, issue);
    }
    return issue;
  };
  const snapshots: ScopeSnapshot[] = moments.map(t => {
    const issues: ScopeIssue[] = [];
    const seen = new Set<string>();
    const visit = (parentId: string, depth: number) => {
      if (depth > 8) return;
      for (const { child, m } of childrenOf.get(parentId) ?? []) {
        const info = byId.get(child);
        if (!info || seen.has(child) || m.from > t || m.to <= t) continue;
        seen.add(child);
        issues.push(issueAt(info, parentId, stateAt(child, t), movedFrom(child, m)));
        visit(child, depth + 1);
      }
    };
    visit(h.contextId, 0);
    return { observedAt: new Date(t).toISOString(), issues };
  });

  // Notes only about the tracked issue's own sub-issues.
  const currentParent = new Map<string, string>();
  for (const [child, list] of memberships) {
    const now = list.find(m => m.to === Infinity);
    if (now) currentParent.set(child, now.parent);
  }
  const underRoot = (id: string) => {
    let parent = currentParent.get(id);
    for (let depth = 0; parent && depth < 32; depth++) {
      if (parent === h.root.id) return true;
      parent = currentParent.get(parent);
    }
    return false;
  };
  let undated = 0;
  for (const [child, list] of memberships) {
    if (list.some(m => m.inferred && m.to === Infinity) && byId.has(child) && underRoot(child)) undated++;
  }
  const warnings: string[] = [];
  if (h.unreadable > 0) {
    warnings.push(`${countOf(h.unreadable, "sub-issue isn't", "sub-issues aren't")} counted: the planner's GitHub access can't read ${h.unreadable === 1 ? 'it' : 'them'}.`);
  }
  if (h.pointsReadable === false) {
    warnings.push(`Can't read the project board's Points, so every issue counts as ${DEFAULT_POINTS} points.`);
  }
  if (undated > 0) {
    warnings.push(`GitHub has no record of when ${countOf(undated, 'issue was', 'issues were')} added, so ${undated === 1 ? 'it counts' : 'they count'} from creation.`);
  }

  const tracking: ScopeTracking = {
    source: 'github',
    root: h.root,
    snapshots,
    checkedAt,
    ...(refreshError ? { refreshError } : {}),
    ...(warnings.length > 0 ? { warnings } : {}),
  };
  if (h.contextId !== h.root.id) {
    const context = analyzeScope({ ...tracking, root: { id: h.contextId, number: 0 } });
    tracking.reference = context.reference.filter(r => r.number !== h.root.number);
  }
  return tracking;
}

/** Whether the tracked issue has, or ever had, sub-issues to show. */
export function hasSubIssues(t: ScopeTracking): boolean {
  return t.snapshots.some(s => {
    const snap = index(s);
    return s.issues.some(issue => isInside(issue, snap, t.root.id));
  });
}
