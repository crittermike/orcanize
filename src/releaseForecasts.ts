import { useEffect, useMemo, useState } from 'react';
import { analyzeScope, issueCompleted, releaseForecast, trackingFromHistory, type GitHubIssueRef, type ReleaseForecast, type ScopeAnalysis } from './scope';
import { lastScope, onScopeStored, requestScope, storeScope, useScopeConfig } from './scopeApi';
import { scopeSourceFor, type ScopeSource } from './ScopePanel';
import { chosenScenarios, demoScope } from './scopeDemo';
import type { Project } from './types';

/** Projects with a release card that a forecast could apply to. */
const hasRelease = (p: Project) =>
  !p.descoped && (!!p.releaseDate || !!p.milestones?.some(m => m.releaseDate && m.url));

/** Issues already requested on this page. */
const requested = new Set<string>();

function analysisFor(slug: string, issue: GitHubIssueRef, source: ScopeSource): ScopeAnalysis | null {
  if (import.meta.env.DEV && source === 'demo') {
    const load = demoScope(issue, chosenScenarios.get(issue.url) ?? 'normal');
    return load.status === 'ready' ? analyzeScope(load.tracking) : null;
  }
  const res = lastScope(slug, issue.url);
  if (res?.status !== 'ready') return null;
  return analyzeScope(trackingFromHistory(res.history, res.checkedAt, res.refreshError ?? undefined));
}

const POLL_MS = 4000;
const MAX_POLLS = 15;

/** Stores the server's cached scope, then polls while it refreshes stale data in the background. */
async function loadUntilFresh(slug: string, url: string) {
  for (let polls = 0; ; polls++) {
    const res = await requestScope(slug, url);
    storeScope(slug, url, res);
    if (res.status !== 'ready' || !res.refreshing || polls >= MAX_POLLS) return;
    await new Promise(resolve => window.setTimeout(resolve, POLL_MS));
  }
}

/** Scope for each active project linked to an issue the server can read.
 *  Each issue is loaded once per page; the server answers from its cache, and stale entries are polled until refreshed.
 *  `version` changes whenever any scope response is stored, including by the project editor. */
function useLinkedScope(slug: string, projects: Project[]) {
  const config = useScopeConfig();
  const [version, setVersion] = useState(0);
  useEffect(() => onScopeStored(() => setVersion(v => v + 1)), []);

  const linked = useMemo(
    () => projects.filter(p => !p.descoped).flatMap(project => {
      const src = scopeSourceFor(project.url, config);
      return src ? [{ project, ...src }] : [];
    }),
    [projects, config],
  );

  useEffect(() => {
    for (const { issue, source } of linked) {
      const key = `${slug}\n${issue.url}`;
      if (source !== 'github' || requested.has(key) || lastScope(slug, issue.url)) continue;
      requested.add(key);
      void loadUntilFresh(slug, issue.url);
    }
  }, [slug, linked]);

  return { linked, version };
}

/** Projects whose linked GitHub issue is closed as completed. */
export function useDoneProjects(slug: string, projects: Project[]): Set<string> {
  const { linked, version } = useLinkedScope(slug, projects);
  return useMemo(() => {
    const done = new Set<string>();
    for (const { project, issue, source } of linked) {
      const res = source === 'github' ? lastScope(slug, issue.url) : undefined;
      if (res?.status === 'ready' && issueCompleted(res.history)) done.add(project.id);
    }
    return done;
    // `version` changes whenever a scope response is stored.
  }, [slug, linked, version]);
}

/** Scope forecasts for release cards, keyed like `ScheduledRelease.key`. */
export function useReleaseForecasts(slug: string, projects: Project[]): Map<string, ReleaseForecast> {
  const all = useLinkedScope(slug, projects);
  const { version } = all;
  const linked = useMemo(() => all.linked.filter(l => hasRelease(l.project)), [all.linked]);

  return useMemo(() => {
    const out = new Map<string, ReleaseForecast>();
    const analyses = new Map<string, ScopeAnalysis | null>();
    for (const { project, issue, source } of linked) {
      if (!analyses.has(issue.url)) analyses.set(issue.url, analysisFor(slug, issue, source));
      const analysis = analyses.get(issue.url);
      if (!analysis) continue;
      const add = (key: string, milestoneUrl: string | undefined, date: string) => {
        const f = releaseForecast(analysis, milestoneUrl, date);
        if (f) out.set(key, f);
      };
      if (project.releaseDate) add(project.id, undefined, project.releaseDate);
      for (const m of project.milestones ?? []) {
        if (m.releaseDate && m.url) add(`${project.id}:${m.id}`, m.url, m.releaseDate);
      }
    }
    return out;
    // `version` changes whenever a scope response is stored.
  }, [slug, linked, version]);
}
