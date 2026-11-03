import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { fmtNum, WEEKS_PER_EM, type CapacityInfo } from './capacityShared';
import { ProjectEditModal, ReleaseDatePicker } from './ProjectModal';
import { milestoneLabel } from './milestones';
import { useModalFocus } from './useModalFocus';
import type { Buffer, Person, PlanState, Project, Quarter } from './types';

type ID = string;

const uid = () => Math.random().toString(36).slice(2, 10);

const PALETTE_BG = [
  '#fecaca', '#fed7aa', '#fef3c7', '#d9f99d', '#bbf7d0',
  '#a5f3fc', '#bfdbfe', '#ddd6fe', '#fbcfe8', '#e2e8f0',
];

const PALETTE_INK: Record<string, string> = {
  '#fecaca': '#7f1d1d', '#fed7aa': '#7c2d12', '#fef3c7': '#713f12',
  '#d9f99d': '#365314', '#bbf7d0': '#14532d', '#a5f3fc': '#155e75',
  '#bfdbfe': '#1e3a8a', '#ddd6fe': '#4c1d95', '#fbcfe8': '#831843',
  '#e2e8f0': '#1e293b',
};
const inkFor = (bg: string) => PALETTE_INK[bg.toLowerCase()] ?? '#1e293b';

export const DEFAULT_QUARTER: Quarter = {
  engineers: 5,
  engineersNote: '',
  weeksInQuarter: 13,
  firstResponderWeeks: 0,
  weeksPerEM: 4,
  buffers: [],
};

export const DEFAULT_BUFFERS: Buffer[] = [
  { id: 'b-hiring', label: 'Hiring & onboarding buffer', pct: 5 },
  { id: 'b-unplanned', label: 'Unplanned work / overhead', pct: 5 },
  { id: 'b-pto', label: 'Vacation & holidays', pct: 9 },
];

export function ensureQuarter(s: PlanState): Quarter {
  return s.quarter ?? DEFAULT_QUARTER;
}

/* ============================================================ */
/* Capacity bars (Estimate + Actual stacked in one section)      */
/* ============================================================ */

type BarSegment = {
  id: string;
  name: string;
  em: number;
  color: string;
  pct: number;
  startPct: number;
  overCapacity: boolean;
};

function computeSegments(
  initiatives: Project[],
  emFor: (p: Project) => number,
  max: number,
  capacityEM: number,
  hasConfiguredQuarter: boolean,
): BarSegment[] {
  let cumulative = 0;
  return initiatives
    .filter(p => emFor(p) > 0)
    .map(p => {
      const em = emFor(p);
      const start = cumulative;
      cumulative += em;
      return {
        id: p.id,
        name: p.name,
        em,
        color: p.color,
        pct: (em / max) * 100,
        startPct: (start / max) * 100,
        overCapacity: hasConfiguredQuarter && start >= capacityEM,
      };
    });
}

function BarRow({
  label,
  segments,
  capacityEM,
  capacityPct,
  hasConfiguredQuarter,
  emptyMessage,
  total,
  capacity,
  hideDelta,
  highlightedProjectId,
  onHoverProject,
  onClick,
  markerVariant = 'standalone',
}: {
  label: string;
  segments: BarSegment[];
  capacityEM: number;
  capacityPct: number;
  hasConfiguredQuarter: boolean;
  emptyMessage: string;
  total: number;
  capacity: number;
  hideDelta?: boolean;
  highlightedProjectId?: ID | null;
  onHoverProject?: (id: ID | null) => void;
  onClick?: () => void;
  markerVariant?: 'standalone' | 'top' | 'bottom';
}) {
  const delta = capacity - total;
  const over = hasConfiguredQuarter && delta < -0.0001;
  const under = hasConfiguredQuarter && delta > 0.0001;
  const deltaAbs = Math.abs(delta);
  const hasHover = highlightedProjectId != null;
  // Local hover — only show the tooltip on the bar the cursor is actually over,
  // even though `highlightedProjectId` is shared across both bars for cross-chart highlight.
  const [localHoverId, setLocalHoverId] = useState<ID | null>(null);
  const hovered = segments.find(s => s.id === localHoverId) || null;

  // Refs to each segment element so we can fixed-position a tooltip above it
  // (the bars live inside an overflow-hidden panel, so an absolutely-positioned
  // tooltip would get clipped).
  const segRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const [tooltipBox, setTooltipBox] = useState<{ left: number; top: number; placement: 'above' | 'below' } | null>(null);

  useLayoutEffect(() => {
    if (!hovered) {
      setTooltipBox(null);
      return;
    }
    const el = segRefs.current[hovered.id];
    if (!el) {
      setTooltipBox(null);
      return;
    }
    const update = () => {
      const r = el.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      // Prefer above; flip below if there isn't ~36px of room above
      const placement: 'above' | 'below' = r.top > 36 ? 'above' : 'below';
      const top = placement === 'above' ? r.top - 6 : r.bottom + 6;
      setTooltipBox({ left: cx, top, placement });
    };
    update();
    // Re-read on scroll/resize while the hover persists
    window.addEventListener('scroll', update, true);
    window.addEventListener('resize', update);
    return () => {
      window.removeEventListener('scroll', update, true);
      window.removeEventListener('resize', update);
    };
  }, [hovered]);

  const handleSegmentEnter = (id: ID) => {
    setLocalHoverId(id);
    onHoverProject?.(id);
  };
  const handleBarLeave = () => {
    setLocalHoverId(null);
    onHoverProject?.(null);
  };

  return (
    <div className="flex items-center gap-3">
      <div className="w-[68px] shrink-0 text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-500">
        {label}
      </div>
      <div
        className={'relative h-9 flex-1 overflow-visible rounded-lg bg-ink-100' + (onClick ? ' cursor-pointer' : '')}
        onMouseLeave={handleBarLeave}
        onClick={onClick}
      >
        {segments.map(seg => {
          const isHovered = highlightedProjectId === seg.id;
          const isDimmed = hasHover && !isHovered;
          // When the capacity marker crosses this segment, keep the label on the larger side of it.
          const showMarker = hasConfiguredQuarter && capacityEM > 0 && capacityPct < 100;
          const split = showMarker && capacityPct > seg.startPct && capacityPct < seg.startPct + seg.pct
            ? (capacityPct - seg.startPct) / seg.pct
            : null;
          const labelOnRight = split != null && split < 0.5;
          const roomPct = split == null ? seg.pct : seg.pct * (labelOnRight ? 1 - split : split);
          const labelStyle = split == null
            ? undefined
            : labelOnRight
              ? { marginLeft: `calc(${split * 100}% + 2px)`, width: `calc(${(1 - split) * 100}% - 2px)` }
              : { maxWidth: `calc(${split * 100}% - 8px)` };
          return (
            <div
              key={seg.id}
              ref={el => { segRefs.current[seg.id] = el; }}
              onMouseEnter={() => handleSegmentEnter(seg.id)}
              className={
                'absolute top-0 flex h-full items-center overflow-hidden px-1.5 text-[10px] font-semibold tabular-nums transition-[transform,box-shadow,opacity] duration-100 ' +
                (isHovered ? 'z-10 -translate-y-px shadow-md ring-2 ring-ink-900 ring-offset-1 ring-offset-white' : '')
              }
              style={{
                left: `${seg.startPct}%`,
                width: `${seg.pct}%`,
                backgroundColor: seg.color,
                color: inkFor(seg.color),
                opacity: isDimmed ? 0.35 : seg.overCapacity ? 0.55 : 1,
                justifyContent: roomPct > 10 || split != null ? 'flex-start' : 'center',
              }}
            >
              {roomPct > 6 && (
                <span className="flex w-full min-w-0 items-baseline gap-1.5" style={labelStyle}>
                  {roomPct > 10 && (
                    <span className="min-w-0 flex-1 truncate font-medium opacity-90">{seg.name || 'Untitled'}</span>
                  )}
                  <span className="shrink-0">{fmtNum(seg.em, 1)}</span>
                </span>
              )}
            </div>
          );
        })}
        {hasConfiguredQuarter && capacityEM > 0 && capacityPct < 100 && (
          <div
            className={
              'pointer-events-none absolute w-[2px] bg-ink-900 ' +
              (markerVariant === 'top'
                ? '-top-1 -bottom-[11px]'
                : markerVariant === 'bottom'
                  ? '-top-[11px] -bottom-1'
                  : '-top-1 -bottom-1')
            }
            style={{ left: `calc(${capacityPct}% - 1px)` }}
            title={`Capacity: ${fmtNum(capacityEM, 1)} EM`}
          >
            {markerVariant !== 'bottom' && (
              <div
                className={'absolute bottom-full mb-0.5 whitespace-nowrap text-[10px] font-semibold tabular-nums text-ink-700' + (onClick ? ' pointer-events-auto hover:underline' : '')}
                style={capacityPct > 90 ? { right: 0 } : { left: '50%', transform: 'translateX(-50%)' }}
                title={onClick ? 'Quarter setup' : undefined}
              >
                {fmtNum(capacityEM, 1)} EM
              </div>
            )}
          </div>
        )}
        {segments.length === 0 && (
          <div className="absolute inset-0 flex items-center justify-center text-[11px] text-ink-400">
            {emptyMessage}
          </div>
        )}
      </div>
      {hovered && tooltipBox && (
        <div
          className="pointer-events-none fixed z-50 whitespace-nowrap rounded-md bg-ink-900 px-2 py-1 text-[11px] font-semibold text-white shadow-lg"
          style={{
            left: tooltipBox.left,
            top: tooltipBox.top,
            transform:
              tooltipBox.placement === 'above'
                ? 'translate(-50%, -100%)'
                : 'translate(-50%, 0)',
          }}
          role="tooltip"
        >
          <span>{hovered.name || 'Untitled'}</span>
          <span className="ml-1.5 text-[10px] font-normal opacity-80">
            {fmtNum(hovered.em)} EM{hovered.overCapacity ? ' · over capacity' : ''}
          </span>
          <span
            className={
              'absolute left-1/2 h-0 w-0 -translate-x-1/2 border-x-[5px] border-x-transparent ' +
              (tooltipBox.placement === 'above'
                ? 'top-full border-t-[5px] border-t-ink-900'
                : 'bottom-full border-b-[5px] border-b-ink-900')
            }
            aria-hidden
          />
        </div>
      )}
      <div className="w-[120px] shrink-0 text-right">
        {hideDelta || (!over && !under) ? (
          <div className="text-[12px] font-semibold tabular-nums text-ink-400">
            {hasConfiguredQuarter ? 'On target' : ''}
          </div>
        ) : (
          <div
            className={
              'inline-flex items-baseline gap-1 rounded-md px-2 py-1 text-[12px] font-semibold tabular-nums ' +
              (over ? 'bg-rose-50 text-rose-700' : 'bg-emerald-50 text-emerald-700')
            }
            title={over ? `Over capacity by ${fmtNum(deltaAbs, 1)} EM` : `${fmtNum(deltaAbs, 1)} EM of capacity unplanned`}
          >
            <span>{fmtNum(deltaAbs, 1)}</span>
            <span className="text-[10px] font-normal opacity-70">EM {over ? 'over' : 'unplanned'}</span>
          </div>
        )}
      </div>
    </div>
  );
}

export function CapacityBars({
  info,
  initiatives,
  plannedByProject,
  onConfigureQuarter,
  highlightedProjectId,
  onHoverProject,
}: {
  info: CapacityInfo;
  initiatives: Project[];
  plannedByProject: Record<ID, number>;
  onConfigureQuarter?: () => void;
  highlightedProjectId?: ID | null;
  onHoverProject?: (id: ID | null) => void;
}) {
  const { capacityEM, demandEM, hasConfiguredQuarter } = info;

  const plannedEM = useMemo<Record<ID, number>>(() => {
    const out: Record<ID, number> = {};
    for (const [pid, weeks] of Object.entries(plannedByProject)) {
      out[pid] = weeks / WEEKS_PER_EM;
    }
    return out;
  }, [plannedByProject]);
  const totalPlanned = useMemo(
    () => initiatives.reduce((s, p) => s + (plannedEM[p.id] ?? 0), 0),
    [initiatives, plannedEM],
  );

  const max = Math.max(capacityEM, demandEM, totalPlanned, 1);
  const capacityPct = Math.min(100, (capacityEM / max) * 100);

  const estimateSegments = computeSegments(
    initiatives,
    p => p.estimateEM ?? 0,
    max,
    capacityEM,
    hasConfiguredQuarter,
  );
  const actualSegments = computeSegments(
    initiatives,
    p => plannedEM[p.id] ?? 0,
    max,
    capacityEM,
    hasConfiguredQuarter,
  );

  return (
    <div className={'space-y-2.5' + (hasConfiguredQuarter && capacityEM > 0 && capacityPct < 100 ? ' pt-3.5' : '')}>
      <BarRow
        label="Estimate"
        segments={estimateSegments}
        capacityEM={capacityEM}
        capacityPct={capacityPct}
        hasConfiguredQuarter={hasConfiguredQuarter}
        emptyMessage={hasConfiguredQuarter ? 'No estimates yet. Add projects below.' : 'Set up the quarter to see capacity, then add projects.'}
        total={demandEM}
        capacity={capacityEM}
        highlightedProjectId={highlightedProjectId}
        onHoverProject={onHoverProject}
        onClick={onConfigureQuarter}
        markerVariant="top"
      />
      <BarRow
        label="Actual"
        segments={actualSegments}
        capacityEM={capacityEM}
        capacityPct={capacityPct}
        hasConfiguredQuarter={hasConfiguredQuarter}
        emptyMessage="Nothing planned yet. Drag projects onto the chart below."
        total={totalPlanned}
        capacity={capacityEM}
        highlightedProjectId={highlightedProjectId}
        onHoverProject={onHoverProject}
        onClick={onConfigureQuarter}
        markerVariant="bottom"
      />
    </div>
  );
}

/* ============================================================ */
/* Quarter modal                                                  */
/* ============================================================ */

export function QuarterModal({
  open,
  onClose,
  info,
  updateQuarter,
  addBuffer,
  updateBuffer,
  removeBuffer,
  installDefaultBuffers,
}: {
  open: boolean;
  onClose: () => void;
  info: CapacityInfo;
  updateQuarter: (patch: Partial<Quarter>) => void;
  addBuffer: () => void;
  updateBuffer: (id: ID, patch: Partial<Buffer>) => void;
  removeBuffer: (id: ID) => void;
  installDefaultBuffers: () => void;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const dialogRef = useRef<HTMLDivElement>(null);
  useModalFocus(dialogRef, open);

  if (!open) return null;

  const { quarter, minusFR, bufferPctSum, remainingPct, capacityEM, hasConfiguredQuarter } = info;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-ink-900/40 px-4 py-10 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="quarter-modal-title"
        tabIndex={-1}
        className="w-full max-w-3xl rounded-2xl bg-white shadow-xl outline-none"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 border-b border-ink-100 px-5 py-3.5">
          <h2 id="quarter-modal-title" className="text-[15px] font-semibold tracking-tight text-ink-900">Quarter</h2>
          {!hasConfiguredQuarter && (
            <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10.5px] font-semibold uppercase tracking-[0.06em] text-amber-700">
              Defaults
            </span>
          )}
          <span className="flex-1" />
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="inline-flex h-8 w-8 items-center justify-center rounded-md text-ink-400 transition hover:bg-ink-100 hover:text-ink-700"
          >
            ×
          </button>
        </div>

        <div className="px-5 pb-5 pt-4">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <NumberField
              label="Engineers"
              value={quarter.engineers}
              onChange={n => updateQuarter({ engineers: n })}
              step={0.25}
              min={0}
            />
            <NumberField
              label="Weeks in quarter"
              value={quarter.weeksInQuarter}
              onChange={n => updateQuarter({ weeksInQuarter: n })}
              step={1}
              min={1}
            />
            <NumberField
              label="First responder weeks"
              value={quarter.firstResponderWeeks}
              onChange={n => updateQuarter({ firstResponderWeeks: n })}
              step={1}
              min={0}
              hint={
                info.frWeeksInPlan > 0
                  ? `${info.frWeeksInPlan} marked in plan${
                      info.frWeeksInPlan !== quarter.firstResponderWeeks ? ' — click to sync' : ''
                    }`
                  : 'Total person-weeks reserved for on-call rotation'
              }
              hintTone={
                info.frWeeksInPlan > 0 && info.frWeeksInPlan !== quarter.firstResponderWeeks
                  ? 'warn'
                  : undefined
              }
              onHintClick={
                info.frWeeksInPlan > 0 && info.frWeeksInPlan !== quarter.firstResponderWeeks
                  ? () => updateQuarter({ firstResponderWeeks: info.frWeeksInPlan })
                  : undefined
              }
            />
          </div>

          <label className="mt-3 block">
            <span className="mb-1 block text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-500">
              Engineers — notes
            </span>
            <textarea
              value={quarter.engineersNote ?? ''}
              onChange={e => updateQuarter({ engineersNote: e.target.value })}
              rows={2}
              placeholder="e.g. SE1 backfill, Sofia ramp 0.75, Steve off-team"
              className="block w-full resize-y rounded-lg border border-ink-200 bg-white px-3 py-2 text-[13px] text-ink-900 outline-none transition focus:border-brand-400 focus:ring-2 focus:ring-brand-200"
            />
          </label>

          <div className="mt-5">
            <div className="mb-2 flex items-center gap-2">
              <h3 className="text-[12px] font-semibold uppercase tracking-[0.08em] text-ink-600">Buffers</h3>
              <span className="flex-1" />
              {quarter.buffers.length === 0 && (
                <button
                  type="button"
                  onClick={installDefaultBuffers}
                  className="inline-flex h-6 items-center gap-1 rounded-md border border-ink-200 bg-white px-2 text-[11px] font-medium text-ink-600 hover:bg-ink-50"
                >
                  Install defaults
                </button>
              )}
              <button
                type="button"
                onClick={addBuffer}
                className="inline-flex h-6 items-center gap-1 rounded-md bg-ink-100 px-2 text-[11px] font-medium text-ink-700 hover:bg-ink-200"
              >
                + Buffer
              </button>
            </div>

            {quarter.buffers.length === 0 ? (
              <div className="rounded-lg border border-dashed border-ink-200 bg-ink-50/40 px-4 py-4 text-center text-[12px] text-ink-500">
                No buffers yet. Add one for things like PTO, on-call overhead, or unplanned work.
              </div>
            ) : (
              <div className="overflow-hidden rounded-lg border border-ink-200">
                <table className="w-full">
                  <thead>
                    <tr className="bg-ink-50 text-[10.5px] font-semibold uppercase tracking-[0.06em] text-ink-500">
                      <th className="px-3 py-1.5 text-left">Label</th>
                      <th className="w-[80px] px-3 py-1.5 text-right">%</th>
                      <th className="px-3 py-1.5 text-left">Note</th>
                      <th className="w-[40px] px-3 py-1.5" />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-ink-100">
                    {quarter.buffers.map(b => (
                      <tr key={b.id}>
                        <td className="px-3 py-1.5">
                          <input
                            value={b.label}
                            onChange={e => updateBuffer(b.id, { label: e.target.value })}
                            className="w-full rounded-md border border-transparent bg-transparent px-1.5 py-1 text-[13px] text-ink-900 outline-none transition hover:bg-ink-50 focus:border-ink-300 focus:bg-white focus:ring-2 focus:ring-brand-200"
                          />
                        </td>
                        <td className="px-3 py-1.5 text-right">
                          <input
                            type="number"
                            step={0.5}
                            min={0}
                            max={100}
                            value={b.pct}
                            onChange={e => updateBuffer(b.id, { pct: Number(e.target.value) || 0 })}
                            className="w-[60px] rounded-md border border-ink-200 bg-white px-1.5 py-1 text-right text-[13px] text-ink-900 outline-none transition focus:border-brand-400 focus:ring-2 focus:ring-brand-200"
                          />
                          <span className="ml-0.5 text-[11px] text-ink-400">%</span>
                        </td>
                        <td className="px-3 py-1.5">
                          <input
                            value={b.note ?? ''}
                            onChange={e => updateBuffer(b.id, { note: e.target.value || undefined })}
                            placeholder="optional note"
                            className="w-full rounded-md border border-transparent bg-transparent px-1.5 py-1 text-[12.5px] text-ink-600 outline-none transition placeholder:text-ink-300 hover:bg-ink-50 focus:border-ink-300 focus:bg-white focus:ring-2 focus:ring-brand-200"
                          />
                        </td>
                        <td className="px-3 py-1.5">
                          <button
                            type="button"
                            onClick={() => removeBuffer(b.id)}
                            title="Remove buffer"
                            aria-label="Remove buffer"
                            className="inline-flex h-6 w-6 items-center justify-center rounded text-ink-400 transition hover:bg-rose-50 hover:text-rose-600"
                          >
                            ×
                          </button>
                        </td>
                      </tr>
                    ))}
                    <tr className="bg-ink-50/60 text-[12px]">
                      <td className="px-3 py-1.5 text-right font-semibold text-ink-600">Subtotal remaining</td>
                      <td className="px-3 py-1.5 text-right font-semibold tabular-nums text-ink-900">{fmtNum(remainingPct)}%</td>
                      <td className="px-3 py-1.5 text-[11px] text-ink-500">{fmtNum(bufferPctSum)}% subtracted</td>
                      <td />
                    </tr>
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div className="mt-5 rounded-lg border border-ink-200 bg-gradient-to-br from-brand-50/50 to-white px-5 py-4">
            <div className="flex items-center justify-between gap-4">
              <div>
                <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-500">
                  Engineering months of capacity
                </div>
                <div className="mt-0.5 text-[11.5px] text-ink-500">
                  <span className="tabular-nums">{fmtNum(quarter.engineers)}</span> eng ×{' '}
                  <span className="tabular-nums">{quarter.weeksInQuarter}</span> wk
                  {quarter.firstResponderWeeks > 0 && (
                    <> − <span className="tabular-nums">{quarter.firstResponderWeeks}</span> FR</>
                  )}{' '}
                  = <span className="tabular-nums">{fmtNum(minusFR)}</span> person-wk
                  {bufferPctSum > 0 && (
                    <> × <span className="tabular-nums">{fmtNum(remainingPct)}%</span></>
                  )}{' '}
                  ÷ <span className="tabular-nums">{quarter.weeksPerEM}</span> wk/EM
                </div>
              </div>
              <div className="text-right">
                <div className="text-[32px] font-bold leading-none tabular-nums text-ink-900">
                  {fmtNum(capacityEM, 1)}
                </div>
                <div className="text-[11px] font-medium uppercase tracking-[0.06em] text-ink-500">EM</div>
              </div>
            </div>
          </div>

          <div className="mt-5 flex justify-end">
            <button
              type="button"
              onClick={onClose}
              className="inline-flex h-9 items-center rounded-lg bg-brand-600 px-4 text-[13px] font-semibold text-white shadow-sm transition hover:bg-brand-700 active:scale-[0.98]"
            >
              Done
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ============================================================ */
/* Initiatives block                                             */
/* ============================================================ */

export function PrioritizationTable({
  initiatives,
  people,
  peopleById,
  capacityEM,
  demandEM,
  fitMarkerIndex,
  showWhatFits,
  addInitiative,
  updateProject,
  descopeInitiative,
  removeInitiative,
  moveProjectToIndex,
  weeksPerEM,
  plannedByProject,
  doneProjectIds,
  onEdit,
  highlightedProjectId,
  onHoverProject,
}: {
  initiatives: Project[];
  people: Person[];
  peopleById: Record<ID, Person>;
  capacityEM: number;
  demandEM: number;
  fitMarkerIndex: number;
  showWhatFits: boolean;
  addInitiative: () => void;
  updateProject: (id: ID, patch: Partial<Project>) => void;
  descopeInitiative: (id: ID) => void;
  removeInitiative: (id: ID) => void;
  moveProjectToIndex: (id: ID, targetIndex: number) => void;
  weeksPerEM: number;
  plannedByProject: Record<ID, number>;
  doneProjectIds?: Set<ID>;
  onEdit: (id: ID) => void;
  highlightedProjectId?: ID | null;
  onHoverProject?: (id: ID | null) => void;
}) {
  void capacityEM; void demandEM; void people; // people reserved for future inline pickers
  const [dragOverIdx, setDragOverIdx] = useState<number | null>(null);
  const [dragOverPos, setDragOverPos] = useState<'before' | 'after'>('before');
  const [draggingId, setDraggingId] = useState<ID | null>(null);

  const clearDragState = () => {
    setDragOverIdx(null);
    setDraggingId(null);
  };

  if (initiatives.length === 0) {
    return (
      <div className="px-6 py-12 text-center text-[13px] text-ink-500">
        No projects yet. Click{' '}
        <button
          type="button"
          onClick={addInitiative}
          className="rounded bg-ink-100 px-1.5 py-0.5 font-semibold text-ink-700 hover:bg-ink-200"
        >
          + Add project
        </button>{' '}
        to start.
      </div>
    );
  }
  return (
    <table
      className="w-full"
      onMouseLeave={onHoverProject ? () => onHoverProject(null) : undefined}
      onDragEnd={clearDragState}
    >
      <thead>
        <tr className="border-b border-ink-200 bg-ink-50/60 text-[10.5px] font-semibold uppercase tracking-[0.06em] text-ink-500">
          <th className="w-[52px] px-2 py-2 text-center">#</th>
          <th className="px-2 py-2 text-left">Project</th>
          <th className="w-[120px] px-2 py-2 text-left">DRI</th>
          <th className="w-[180px] px-2 py-2 text-right">Estimate (Eng Months)</th>
          <th scope="col" className="w-[190px] whitespace-nowrap px-2 py-2 text-left" title="Communicated ship date">Release date</th>
          <th className="px-2 py-2 text-left">Notes</th>
          <th className="w-[100px] px-2 py-2 text-right">Actions</th>
        </tr>
      </thead>
      <tbody>
        {initiatives.map((p, idx) => (
          <InitiativeRow
            key={p.id}
            project={p}
            index={idx}
            dri={p.driId ? peopleById[p.driId] ?? null : null}
            showWhatFits={showWhatFits}
            pastFitLine={fitMarkerIndex !== -1 && idx >= fitMarkerIndex}
            isFitLine={showWhatFits && idx === fitMarkerIndex}
            weeksPerEM={weeksPerEM}
            plannedWeeks={plannedByProject[p.id] ?? 0}
            isDone={doneProjectIds?.has(p.id) ?? false}
            isHighlighted={highlightedProjectId === p.id}
            isDimmed={highlightedProjectId != null && highlightedProjectId !== p.id}
            isBeingDragged={draggingId === p.id}
            dropIndicator={dragOverIdx === idx ? dragOverPos : null}
            onHover={onHoverProject ? () => onHoverProject(p.id) : undefined}
            onUpdate={patch => updateProject(p.id, patch)}
            onEdit={() => onEdit(p.id)}
            onDescope={() => descopeInitiative(p.id)}
            onDelete={() => removeInitiative(p.id)}
            onDragStart={() => setDraggingId(p.id)}
            onDragOverRow={pos => {
              if (draggingId == null) return;
              setDragOverIdx(idx);
              setDragOverPos(pos);
            }}
            onDropRow={() => {
              if (!draggingId) return;
              const fromIdx = initiatives.findIndex(it => it.id === draggingId);
              if (fromIdx === -1) {
                clearDragState();
                return;
              }
              let target = idx + (dragOverPos === 'after' ? 1 : 0);
              if (fromIdx < target) target -= 1;
              if (target !== fromIdx) {
                moveProjectToIndex(draggingId, target);
              }
              clearDragState();
            }}
          />
        ))}
      </tbody>
    </table>
  );
}

function InitiativeRow({
  project,
  index,
  dri,
  showWhatFits,
  pastFitLine,
  isFitLine,
  weeksPerEM,
  plannedWeeks,
  isDone,
  isHighlighted,
  isDimmed,
  isBeingDragged,
  dropIndicator,
  onHover,
  onUpdate,
  onEdit,
  onDescope,
  onDelete,
  onDragStart,
  onDragOverRow,
  onDropRow,
}: {
  project: Project;
  index: number;
  dri: Person | null;
  showWhatFits: boolean;
  pastFitLine: boolean;
  isFitLine: boolean;
  weeksPerEM: number;
  plannedWeeks: number;
  isDone: boolean;
  isHighlighted?: boolean;
  isDimmed?: boolean;
  isBeingDragged?: boolean;
  dropIndicator: 'before' | 'after' | null;
  onHover?: () => void;
  onUpdate: (patch: Partial<Project>) => void;
  onEdit: () => void;
  onDescope: () => void;
  onDelete: () => void;
  onDragStart: () => void;
  onDragOverRow: (pos: 'before' | 'after') => void;
  onDropRow: () => void;
}) {
  const fadedClass = (showWhatFits && pastFitLine ? 'opacity-50' : '') + (isDimmed ? ' opacity-60' : '');
  const highlightClass = isHighlighted
    ? 'bg-amber-50/70 ring-1 ring-inset ring-amber-300/70'
    : '';
  const draggingClass = isBeingDragged ? 'opacity-40' : '';

  const est = project.estimateEM;
  const plannedEM = weeksPerEM > 0 ? plannedWeeks / weeksPerEM : 0;
  let emBadgeClass = 'border-transparent text-ink-300';
  let emBadgeText = '—';
  let emBadgeTitle = 'Click to set estimate';
  if (est != null) {
    emBadgeText = plannedEM > 0.01 ? `${fmtNum(plannedEM)} / ${fmtNum(est)}` : fmtNum(est);
    emBadgeClass = 'border-ink-200 bg-white text-ink-800 font-semibold';
    if (plannedEM > est + 0.01) emBadgeClass = 'border-rose-200 bg-rose-50 text-rose-700 font-semibold';
    else if (Math.abs(plannedEM - est) <= 0.01 && plannedEM > 0) emBadgeClass = 'border-emerald-200 bg-emerald-50 text-emerald-700 font-semibold';
    emBadgeTitle = `Estimated ${fmtNum(est)} EM · planned ${fmtNum(plannedEM)} EM — click to edit`;
  } else if (plannedEM > 0.01) {
    emBadgeText = `${fmtNum(plannedEM)} / —`;
    emBadgeClass = 'border-ink-200 bg-white text-ink-600';
    emBadgeTitle = `Planned ${fmtNum(plannedEM)} EM, no estimate — click to set`;
  }

  const handleRowDragOver = (e: React.DragEvent<HTMLTableRowElement>) => {
    if (!e.dataTransfer.types.includes('application/x-reorder-project')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const rect = e.currentTarget.getBoundingClientRect();
    const midY = rect.top + rect.height / 2;
    onDragOverRow(e.clientY < midY ? 'before' : 'after');
  };
  const handleRowDrop = (e: React.DragEvent<HTMLTableRowElement>) => {
    if (!e.dataTransfer.types.includes('application/x-reorder-project')) return;
    e.preventDefault();
    onDropRow();
  };

  const indicatorClass = dropIndicator === 'before'
    ? 'border-t-2 border-t-brand-500'
    : dropIndicator === 'after'
      ? 'border-b-2 border-b-brand-500'
      : 'border-b border-ink-100';

  return (
    <>
      {isFitLine && showWhatFits && (
        <tr aria-hidden>
          <td colSpan={7} className="border-t border-rose-200 px-3 pb-0.5 pt-1 text-[11px] font-medium text-rose-600">
            Over capacity
          </td>
        </tr>
      )}
      <tr
        onMouseEnter={onHover}
        onDragOver={handleRowDragOver}
        onDrop={handleRowDrop}
        className={'group align-middle transition ' + indicatorClass + ' ' + highlightClass + ' ' + fadedClass + ' ' + draggingClass}
      >
        <td className="px-2 py-2 text-center align-middle">
          <div className="inline-flex items-center gap-1">
            <button
              type="button"
              aria-label="Drag to reorder"
              title="Drag to reorder"
              draggable
              onDragStart={e => {
                e.dataTransfer.setData('application/x-reorder-project', project.id);
                e.dataTransfer.effectAllowed = 'move';
                onDragStart();
              }}
              className="cursor-grab text-ink-300 opacity-0 transition group-hover:opacity-100 hover:text-ink-700 active:cursor-grabbing"
            >
              <svg width="10" height="14" viewBox="0 0 10 14" aria-hidden>
                <g fill="currentColor">
                  <circle cx="2" cy="2" r="1.25" />
                  <circle cx="8" cy="2" r="1.25" />
                  <circle cx="2" cy="7" r="1.25" />
                  <circle cx="8" cy="7" r="1.25" />
                  <circle cx="2" cy="12" r="1.25" />
                  <circle cx="8" cy="12" r="1.25" />
                </g>
              </svg>
            </button>
            <span className="text-[12px] font-semibold tabular-nums text-ink-700">{project.priority ?? index + 1}</span>
          </div>
        </td>
        <td className="px-2 py-2">
          <button
            type="button"
            onClick={onEdit}
            title="Edit project"
            className="inline-flex w-full min-w-0 items-center gap-2 rounded-md px-1.5 py-1 text-left"
          >
            <span
              className="inline-flex h-5 shrink-0 cursor-grab items-center rounded-full border border-black/5 px-2 text-[11px] font-semibold tracking-tight active:cursor-grabbing"
              style={{ background: project.color, color: inkFor(project.color) }}
              draggable
              onDragStart={e => {
                e.stopPropagation();
                e.dataTransfer.setData('application/x-project', project.id);
                e.dataTransfer.effectAllowed = 'copy';
              }}
              title="Drag to chart to assign"
              aria-hidden
            >
              {project.name.slice(0, 1).toUpperCase() || '·'}
            </span>
            <span className={'truncate text-[13.5px] font-medium ' + (isDone ? 'text-ink-500' : 'text-ink-900')}>
              {project.name || <span className="italic text-ink-400">Untitled</span>}
            </span>
            {isDone && (
              <span className="shrink-0 text-[11.5px] font-medium text-emerald-600" title="Issue closed as completed">
                ✓ Done
              </span>
            )}
          </button>
        </td>
        <td className="px-2 py-2 align-middle">
          <button
            type="button"
            onClick={onEdit}
            title={dri ? `DRI: ${dri.name} — click to edit` : 'No DRI — click to set'}
            className="block w-full truncate rounded-md px-1.5 py-1 text-left text-[12.5px]"
          >
            {dri
              ? <span className="truncate text-ink-700">{dri.name}</span>
              : <span className="italic text-ink-300">—</span>}
          </button>
        </td>
        <td className="px-2 py-2 text-right align-middle">
          <button
            type="button"
            onClick={onEdit}
            title={emBadgeTitle}
            className={
              'inline-flex h-7 items-center justify-end gap-1 rounded-full border px-3 text-[12.5px] tabular-nums transition hover:border-ink-300 ' +
              emBadgeClass
            }
          >
            {emBadgeText}
            <span className="text-[10px] opacity-70">EM</span>
          </button>
        </td>
        <td className="px-2 py-2 align-middle">
          <ReleaseDatePicker
            value={project.releaseDate}
            name={project.name || 'Untitled project'}
            onChange={releaseDate => onUpdate({ releaseDate })}
          />
        </td>
        <td className="px-2 py-2 align-middle">
          <button
            type="button"
            onClick={onEdit}
            title={project.notes || 'Click to add notes'}
            className="block w-full truncate rounded-md px-1.5 py-1 text-left text-[12.5px] text-ink-600"
          >
            {project.notes
              ? <span className="truncate">{project.notes}</span>
              : <span className="italic text-ink-300">—</span>}
          </button>
        </td>
        <td className="px-2 py-2 text-right align-middle">
          <div className="inline-flex items-center gap-0.5">
            {project.url && (
              <a
                href={project.url}
                target="_blank"
                rel="noopener noreferrer"
                title={`Open link: ${project.url}`}
                aria-label="Open external link"
                className="inline-flex h-7 w-7 items-center justify-center rounded text-ink-400 transition hover:bg-brand-50 hover:text-brand-600"
                onClick={e => e.stopPropagation()}
              >
                <svg width="13" height="13" viewBox="0 0 14 14" aria-hidden fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M5 3H3v8h8V9" />
                  <path d="M8 2h4v4" />
                  <path d="M12 2l-5 5" />
                </svg>
              </a>
            )}
            <button
              type="button"
              onClick={onDescope}
              title="Descope (hides from chart, recoverable)"
              aria-label="Descope"
              className="inline-flex h-7 w-7 items-center justify-center rounded text-ink-500 transition hover:bg-amber-50 hover:text-amber-700"
            >
              <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="4" cy="11" r="2.2" />
                <circle cx="12" cy="11" r="2.2" />
                <path d="M5.8 9.5L13.5 3" />
                <path d="M10.2 9.5L2.5 3" />
              </svg>
            </button>
            <button
              type="button"
              onClick={onDelete}
              title="Delete permanently"
              aria-label="Delete"
              className="inline-flex h-7 w-7 items-center justify-center rounded text-ink-400 transition hover:bg-rose-50 hover:text-rose-700"
            >
              <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 4.5h10" />
                <path d="M6 4.5V3a1 1 0 011-1h2a1 1 0 011 1v1.5" />
                <path d="M4.5 4.5l.7 8.5a1 1 0 001 .9h3.6a1 1 0 001-.9l.7-8.5" />
                <path d="M7 7.5v4" />
                <path d="M9 7.5v4" />
              </svg>
            </button>
          </div>
        </td>
      </tr>
    </>
  );
}

/* ============================================================ */
/* Descoped drawer                                               */
/* ============================================================ */

export function DescopedDrawer({
  descoped,
  restoreInitiative,
  removeInitiative,
}: {
  descoped: Project[];
  restoreInitiative: (id: ID) => void;
  removeInitiative: (id: ID) => void;
}) {
  const [open, setOpen] = useState(false);
  const totalEM = descoped.reduce((s, p) => s + (p.estimateEM ?? 0), 0);
  return (
    <section className="border-t border-ink-200 bg-white">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="flex w-full items-center gap-2 bg-ink-50/40 px-5 py-3 text-left transition hover:bg-ink-50"
      >
        <span className="text-[15px] font-semibold tracking-tight text-ink-900">Descoped</span>
        <span className="rounded-full bg-ink-100 px-2 py-0.5 text-[11px] font-semibold tabular-nums text-ink-600">
          {descoped.length}
        </span>
        {totalEM > 0 && (
          <span className="text-[12px] text-ink-500">≈ {fmtNum(totalEM, 1)} EM cut</span>
        )}
        <span className="flex-1" />
        <span className="text-[12px] text-ink-400">{open ? 'Hide' : 'Show'}</span>
      </button>
      {open && (
        <ul className="divide-y divide-ink-100">
          {descoped.map(p => (
            <li key={p.id} className="flex items-center gap-2 px-5 py-2">
              <span
                className="inline-block h-3 w-3 shrink-0 rounded-full border border-black/5"
                style={{ background: p.color }}
                aria-hidden
              />
              <span className="min-w-0 flex-1 truncate text-[13px] text-ink-700 line-through opacity-70">
                {p.name}
                {p.estimateEM != null && (
                  <span className="ml-2 text-[11px] tabular-nums text-ink-500">{fmtNum(p.estimateEM)} EM</span>
                )}
              </span>
              <button
                type="button"
                onClick={() => restoreInitiative(p.id)}
                className="inline-flex h-6 items-center rounded border border-ink-200 bg-white px-2 text-[11px] font-medium text-ink-600 transition hover:border-emerald-300 hover:bg-emerald-50 hover:text-emerald-700"
              >
                ↩ Restore
              </button>
              <button
                type="button"
                onClick={() => removeInitiative(p.id)}
                title="Delete permanently"
                aria-label="Delete"
                className="inline-flex h-6 w-6 items-center justify-center rounded text-ink-400 transition hover:bg-rose-50 hover:text-rose-600"
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/* ============================================================ */
/* Number field                                                  */
/* ============================================================ */

function NumberField({
  label,
  value,
  onChange,
  step = 1,
  min,
  max,
  hint,
  hintTone,
  onHintClick,
}: {
  label: string;
  value: number;
  onChange: (n: number) => void;
  step?: number;
  min?: number;
  max?: number;
  hint?: string;
  hintTone?: 'warn';
  onHintClick?: () => void;
}) {
  const hintColor = hintTone === 'warn' ? 'text-amber-700' : 'text-ink-400';
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-500">
        {label}
      </span>
      <input
        type="number"
        step={step}
        min={min}
        max={max}
        value={Number.isFinite(value) ? value : 0}
        onChange={e => {
          const n = Number(e.target.value);
          onChange(Number.isFinite(n) ? n : 0);
        }}
        className="block w-full rounded-lg border border-ink-200 bg-white px-3 py-2 text-[14px] tabular-nums text-ink-900 outline-none transition focus:border-brand-400 focus:ring-2 focus:ring-brand-200"
      />
      {hint && (
        onHintClick ? (
          <button
            type="button"
            onClick={onHintClick}
            className={`mt-1 inline-flex cursor-pointer rounded text-left text-[11px] underline-offset-2 transition hover:underline ${hintColor}`}
          >
            {hint}
          </button>
        ) : (
          <span className={`mt-1 block text-[11px] ${hintColor}`}>{hint}</span>
        )
      )}
    </label>
  );
}
/* ---------------------------------------------------------------- */

function escapeMd(s: string): string {
  return s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

/* ============================================================ */
/* Markdown export                                                */
/* ============================================================ */

export function exportPlanMarkdown(
  state: PlanState,
  info: CapacityInfo,
  activeInitiatives: Project[],
  descopedInitiatives: Project[],
): string {
  const { quarter, capacityEM, demandEM, gap, hasConfiguredQuarter, plannedByProject } = info;
  const lines: string[] = [];
  const title = state.title?.trim() || 'Quarter plan';
  lines.push(`# ${title}`);
  lines.push('');
  lines.push(
    `**Capacity:** ${fmtNum(capacityEM, 1)} EM  ·  **Committed:** ${fmtNum(demandEM, 1)} EM  ·  ` +
      `**Gap:** ${gap >= 0 ? '+' : ''}${fmtNum(gap, 1)} EM`,
  );
  lines.push('');

  if (hasConfiguredQuarter) {
    lines.push('## Quarter setup');
    lines.push(`- Engineers: ${fmtNum(quarter.engineers)}`);
    if (quarter.engineersNote?.trim()) lines.push(`  - ${quarter.engineersNote.trim()}`);
    lines.push(`- Weeks in quarter: ${quarter.weeksInQuarter}`);
    if (quarter.firstResponderWeeks > 0) lines.push(`- First responder weeks: ${quarter.firstResponderWeeks}`);
    lines.push(`- Weeks per EM: ${quarter.weeksPerEM}`);
    if (quarter.buffers.length > 0) {
      lines.push('- Buffers:');
      for (const b of quarter.buffers) {
        const note = b.note?.trim() ? ` — ${b.note.trim()}` : '';
        lines.push(`  - ${b.label}: ${fmtNum(b.pct)}%${note}`);
      }
    }
    lines.push('');
  }

  lines.push('## Committed');
  if (activeInitiatives.length === 0) {
    lines.push('_None yet._');
  } else {
    lines.push('| # | Project | EM est | EM planned | Release date | Notes |');
    lines.push('|---|---------|-------:|-----------:|--------------|-------|');
    activeInitiatives.forEach((p, i) => {
      const est = p.estimateEM != null ? fmtNum(p.estimateEM) : '—';
      const plannedEMVal = (plannedByProject[p.id] ?? 0) / WEEKS_PER_EM;
      const planned = plannedEMVal > 0 ? fmtNum(plannedEMVal) : '0';
      const releaseDate = p.releaseDate ? escapeMd(p.releaseDate) : '—';
      const notes = p.notes ? escapeMd(p.notes) : '';
      lines.push(`| ${i + 1} | ${escapeMd(p.name)} | ${est} | ${planned} | ${releaseDate} | ${notes} |`);
    });
  }
  lines.push('');

  const milestoneRows = activeInitiatives.flatMap(p =>
    (p.milestones ?? []).map(m => ({ project: p, milestone: m })),
  );
  if (milestoneRows.length > 0) {
    lines.push('## Milestones');
    lines.push('| Project | Milestone | Ship date |');
    lines.push('|---------|-----------|-----------|');
    for (const { project, milestone } of milestoneRows) {
      const shipDate = milestone.releaseDate ? escapeMd(milestone.releaseDate) : '—';
      lines.push(`| ${escapeMd(project.name)} | ${escapeMd(milestoneLabel(milestone))} | ${shipDate} |`);
    }
    lines.push('');
  }

  if (descopedInitiatives.length > 0) {
    lines.push('## Descoped');
    lines.push('| # | Project | EM est | Release date | Notes |');
    lines.push('|---|---------|-------:|--------------|-------|');
    descopedInitiatives.forEach((p, i) => {
      const est = p.estimateEM != null ? fmtNum(p.estimateEM) : '—';
      const releaseDate = p.releaseDate ? escapeMd(p.releaseDate) : '—';
      const notes = p.notes ? escapeMd(p.notes) : '';
      lines.push(`| ${i + 1} | ${escapeMd(p.name)} | ${est} | ${releaseDate} | ${notes} |`);
    });
    lines.push('');
  }

  return lines.join('\n');
}
