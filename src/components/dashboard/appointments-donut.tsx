"use client"

import { useTranslations } from 'next-intl'
import { CalendarClock } from 'lucide-react'
import type { AppointmentsDonutData } from '@/lib/dashboard/types'
import { EmptyState } from './empty-state'
import { Skeleton } from './skeleton'

interface AppointmentsDonutProps {
  data: AppointmentsDonutData | null
  loading: boolean
}

/**
 * Today's appointments by status — the clinic-relevant replacement for
 * the generic-CRM Pipeline donut. Same ring-chart visual language
 * (see pipeline-donut.tsx), fed appointment counts instead of deal
 * value, no currency involved.
 */
export function AppointmentsDonut({ data, loading }: AppointmentsDonutProps) {
  const t = useTranslations('Dashboard.appointmentsDonut')
  return (
    <section className="flex h-full flex-col rounded-xl border border-border bg-card">
      <header className="border-b border-border px-5 py-4">
        <h2 className="text-sm font-semibold text-foreground">{t('title')}</h2>
        <p className="mt-0.5 text-xs text-muted-foreground">{t('description')}</p>
      </header>

      <div className="flex flex-1 flex-col p-5">
        {loading || !data ? (
          <Skeleton className="h-56 w-full" />
        ) : data.slices.length === 0 ? (
          <EmptyState
            icon={CalendarClock}
            title={t('noAppointments')}
            hint={t('noAppointmentsHint')}
          />
        ) : (
          <>
            <Donut data={data} />
            <ul className="mt-5 space-y-2">
              {data.slices.map((s) => (
                <li key={s.status} className="flex items-center gap-3 text-xs">
                  <span
                    className="h-2.5 w-2.5 flex-shrink-0 rounded-full"
                    style={{ background: s.color }}
                    aria-hidden
                  />
                  <span className="flex-1 truncate text-muted-foreground">
                    {t(`status.${s.status}`)}
                  </span>
                  <span className="text-muted-foreground tabular-nums">
                    {t('count', { count: s.count })}
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </section>
  )
}

// SVG ring — same 200×200 arc-drawing approach as PipelineDonut.
function Donut({ data }: { data: AppointmentsDonutData }) {
  const t = useTranslations('Dashboard.appointmentsDonut')
  const size = 200
  const r = 80
  const ringWidth = 18
  const cx = size / 2
  const cy = size / 2

  const totalRaw = data.total || 1
  const minFrac = 0.02
  const rawShares = data.slices.map((s) => s.count / totalRaw)
  const floored = rawShares.map((x) => Math.max(x, minFrac))
  const floorSum = floored.reduce((a, b) => a + b, 0)
  const shares = floored.map((x) => x / floorSum)

  const offsets: number[] = [0]
  for (let i = 0; i < shares.length; i++) offsets.push(offsets[i] + shares[i])
  const segments = data.slices.map((s, i) => {
    const start = offsets[i] * Math.PI * 2 - Math.PI / 2
    const end = offsets[i + 1] * Math.PI * 2 - Math.PI / 2
    return { path: arcPath(cx, cy, r, start, end), color: s.color, id: s.status }
  })

  return (
    <div className="flex items-center justify-center">
      <svg viewBox={`0 0 ${size} ${size}`} className="h-48 w-48" role="img" aria-label={t('ariaLabel')}>
        <circle cx={cx} cy={cy} r={r} fill="none" stroke="var(--muted)" strokeWidth={ringWidth} />
        {segments.map((seg) => (
          <path
            key={seg.id}
            d={seg.path}
            fill="none"
            stroke={seg.color}
            strokeWidth={ringWidth}
            strokeLinecap="butt"
          />
        ))}
        <text x={cx} y={cy - 6} textAnchor="middle" className="fill-muted-foreground text-[11px]">
          {t('total')}
        </text>
        <text
          x={cx}
          y={cy + 14}
          textAnchor="middle"
          className="fill-foreground text-[18px] font-semibold tabular-nums"
        >
          {data.total}
        </text>
      </svg>
    </div>
  )
}

function arcPath(cx: number, cy: number, r: number, startRad: number, endRad: number): string {
  const x1 = cx + r * Math.cos(startRad)
  const y1 = cy + r * Math.sin(startRad)
  const x2 = cx + r * Math.cos(endRad)
  const y2 = cy + r * Math.sin(endRad)
  const largeArc = endRad - startRad > Math.PI ? 1 : 0
  return `M ${x1} ${y1} A ${r} ${r} 0 ${largeArc} 1 ${x2} ${y2}`
}
