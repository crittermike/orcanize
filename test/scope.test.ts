import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_POINTS, issueCompleted, netChanges, pointsOf, releaseForecast, targetStatus, type HistoryIssue, type ScopeAnalysis, type ScopeEvent, type ScopeSummary } from '../src/scope.ts';
import { pointsFrom } from '../server/scope.js';

test('issueCompleted: only a tracked issue closed as completed is done', () => {
  const history = (root: Partial<HistoryIssue>) => ({
    fetchedAt: '2026-10-19T00:00:00Z',
    root: { id: 'R', number: 1 },
    contextId: 'P',
    unreadable: 0,
    issues: [
      { id: 'P', number: 9, title: 'Parent', url: '', createdAt: '', state: 'closed' as const, closeReason: 'completed' as const, children: ['R'], events: [] },
      { id: 'R', number: 1, title: 'Epic', url: '', createdAt: '', state: 'open' as const, children: [], events: [], ...root },
    ],
  });
  assert.equal(issueCompleted(history({ state: 'closed', closeReason: 'completed' })), true);
  assert.equal(issueCompleted(history({ state: 'closed', closeReason: 'not_planned' })), false);
  assert.equal(issueCompleted(history({})), false);
});

test('pointsOf defaults to 3 when unset or invalid', () => {
  assert.equal(DEFAULT_POINTS, 3);
  assert.equal(pointsOf({ points: null }), 3);
  assert.equal(pointsOf({}), 3);
  assert.equal(pointsOf({ points: 0 }), 3);
  assert.equal(pointsOf({ points: 8 }), 8);
});

test('pointsFrom takes the first numeric Points value', () => {
  assert.equal(pointsFrom({ nodes: [{ fieldValueByName: null }, { fieldValueByName: { name: '5' } }] }), 5);
  assert.equal(pointsFrom({ nodes: [{ fieldValueByName: { name: 'XL' } }] }), null);
  assert.equal(pointsFrom({ nodes: [{ fieldValueByName: { name: '5XL' } }, { fieldValueByName: { name: '2' } }] }), 2);
  assert.equal(pointsFrom({ nodes: [{ fieldValueByName: { number: 2 } }] }), 2);
  assert.equal(pointsFrom(undefined), null);
});

const asOf = new Date(2026, 9, 19, 12).toISOString(); // a Monday
const summary = (over: Partial<ScopeSummary>, rates: [number, number][] = [[1, 0]]): ScopeSummary => ({
  asOf,
  status: 'converging',
  remaining: 2.3,
  pace: {
    own: null, ownWeight: 1, references: [],
    scenarios: rates.map(([completionRate, creepRate]) => ({ label: 'x', completionRate, creepRate })),
    completionRate: rates[0][0],
    creepRate: rates[0][1],
  },
  ...over,
} as ScopeSummary);

test('targetStatus: a converging forecast that finishes after the target is late', () => {
  // 2.3 weeks at 1 pt/week finishes Wednesday Nov 4.
  assert.equal(targetStatus(summary({}), '2026-11-06'), 'on-track');
  assert.equal(targetStatus(summary({}), '2026-11-02'), 'at-risk');
  assert.equal(targetStatus(summary({}), '2026-10-30'), 'late');
  assert.equal(targetStatus(summary({}, [[1, 1]]), '2027-06-01'), 'late');
});

test('targetStatus: ranges are at risk when only some estimates miss', () => {
  assert.equal(targetStatus(summary({ status: 'just-started' }, [[2, 0], [0.5, 0]]), '2026-11-06'), 'at-risk');
  assert.equal(targetStatus(summary({ status: 'just-started' }, [[2, 0], [1.5, 0]]), '2026-11-06'), 'on-track');
});

test('targetStatus: a passed target is late; nothing to compare is null', () => {
  assert.equal(targetStatus(summary({ status: 'too-early', pace: null }), '2026-10-16'), 'late');
  assert.equal(targetStatus(summary({ status: 'too-early', pace: null }), '2026-11-06'), null);
  assert.equal(targetStatus(summary({ status: 'done', remaining: 0 }), '2026-10-16'), null);
  assert.equal(targetStatus(summary({}), undefined), null);
});

const url = (n: number) => `https://github.com/acme/app/issues/${n}`;
const epic = (views: [number, ScopeSummary][]): ScopeAnalysis => ({
  views: views.map(([n, s]) => ({ id: `m${n}`, label: `M${n}`, issue: { url: url(n) } as ScopeAnalysis['views'][number]['issue'], summary: s })),
  hasBreakdown: true, defaultViewId: 'm1', reference: [], outside: null,
});

test('releaseForecast: a milestone card uses its epic milestone and shows the forecast finish when late', () => {
  const a = epic([[11, summary({ status: 'just-started' }, [[2, 0], [0.5, 0]])], [12, summary({})]]);
  assert.deepEqual(releaseForecast(a, url(12), '2026-10-30'), { status: 'late', finishWeek: '2026-11-02' });
  assert.deepEqual(releaseForecast(a, url(12), '2026-11-06'), { status: 'on-track', finishWeek: '2026-11-02' });
  // A range of estimates shows its first and last finish weeks, as the milestone table does.
  assert.deepEqual(releaseForecast(a, url(11), '2026-11-06'), { status: 'at-risk', finishWeek: '2026-10-26', finishWeekEnd: '2026-11-16' });
  assert.equal(releaseForecast(a, url(99), '2026-10-30'), null);
  // An epic has no combined forecast, so its own release card shows nothing.
  assert.equal(releaseForecast(a, undefined, '2026-10-30'), null);
});

test('releaseForecast: a project card uses the whole issue when it has no milestones', () => {
  const single: ScopeAnalysis = { ...epic([]), hasBreakdown: false, views: [{ id: 'all', label: 'All', issue: null, summary: summary({}, [[1, 1]]) }] };
  assert.deepEqual(releaseForecast(single, undefined, '2027-06-01'), { status: 'late', finishWeek: null });
  assert.equal(releaseForecast(single, url(12), '2027-06-01'), null);
});

const issue = (n: number) => ({ id: `i${n}`, number: n, title: `#${n}` }) as ScopeEvent['issue'];
const ev = (day: number, kind: ScopeEvent['kind'], n: number): ScopeEvent => ({ at: `2026-10-${String(day).padStart(2, '0')}T12:00:00Z`, kind, issue: issue(n) });

test('netChanges collapses repeats per issue to the net change', () => {
  const newestFirst = (...e: ScopeEvent[]) => e.reverse();
  const events = newestFirst(
    ev(1, 'completed', 1), ev(2, 'added', 2), ev(5, 'reopened', 1), ev(6, 'completed', 2),
    ev(7, 'completed', 1), ev(8, 'added', 3), ev(9, 'removed', 3),
  );
  assert.deepEqual(netChanges(events).map(e => `${e.at.slice(8, 10)} ${e.kind} ${e.issue.number}`), [
    '07 completed 1',
    '06 completed 2',
    '02 added 2',
  ]);
});
