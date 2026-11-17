import { Bar, BarChart, CartesianGrid, Cell, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { AnalyticsSummary } from '../types/lifeline.ts';

const COLORS = ['#8B5CF6', '#EC4899', '#10B981', '#F59E0B', '#38BDF8'];

export default function OperatorAnalyticsPanel({ analytics }: { analytics: AnalyticsSummary }) {
  const pieData = analytics.demoStats.byCategory.length
    ? analytics.demoStats.byCategory
    : [{ name: 'No Data', count: 1 }];

  return (
    <div className="space-y-6">
      <div className="grid gap-4 md:grid-cols-2">
        {/* Real Live Operational Metrics */}
        <div className="rounded-2xl border border-emerald-500/35 bg-white dark:bg-[#0B1022] p-5 space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="font-display text-base font-bold text-slate-900 dark:text-white">
              Live Operational Metrics
            </h2>
            <span className="rounded bg-emerald-500/15 px-2 py-0.5 font-mono text-[10px] font-bold text-emerald-700 dark:text-emerald-300">
              REAL DATABASE DATA
            </span>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-center">
            <div className="rounded-xl border border-slate-200 dark:border-slate-800 p-3">
              <div className="text-[11px] text-slate-500">Total Live</div>
              <div className="font-display text-2xl font-extrabold tabular-nums">{analytics.liveStats.total}</div>
            </div>
            <div className="rounded-xl border border-slate-200 dark:border-slate-800 p-3">
              <div className="text-[11px] text-slate-500">Active Now</div>
              <div className="font-display text-2xl font-extrabold tabular-nums text-rose-500">
                {analytics.liveStats.active}
              </div>
            </div>
            <div className="rounded-xl border border-slate-200 dark:border-slate-800 p-3">
              <div className="text-[11px] text-slate-500">Avg Ack (s)</div>
              <div className="font-display text-2xl font-extrabold tabular-nums">
                {analytics.liveStats.avgAckSeconds ?? '—'}
              </div>
            </div>
            <div className="rounded-xl border border-slate-200 dark:border-slate-800 p-3">
              <div className="text-[11px] text-slate-500">Avg Resolve (s)</div>
              <div className="font-display text-2xl font-extrabold tabular-nums text-emerald-500">
                {analytics.liveStats.avgResolutionSeconds ?? '—'}
              </div>
            </div>
          </div>
          {analytics.responders && (
            <div className="text-[11px] text-slate-500 dark:text-slate-400">
              Responder Fleet: {analytics.responders.available} Available · {analytics.responders.responding} Responding ·{' '}
              {analytics.responders.offDuty} Off Duty
            </div>
          )}
        </div>

        {/* Simulated Demo Metrics */}
        <div className="rounded-2xl border border-amber-500/35 bg-white dark:bg-[#0B1022] p-5 space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="font-display text-base font-bold text-slate-900 dark:text-white">
              Simulated Sandbox Metrics
            </h2>
            <span className="rounded bg-amber-500/15 px-2 py-0.5 font-mono text-[10px] font-bold text-amber-700 dark:text-amber-300">
              [SIMULATED] DEMO DATA
            </span>
          </div>
          <div className="grid grid-cols-3 gap-3 text-center">
            <div className="rounded-xl border border-slate-200 dark:border-slate-800 p-3">
              <div className="text-[11px] text-slate-500">Total Demo</div>
              <div className="font-display text-2xl font-extrabold tabular-nums">{analytics.demoStats.total}</div>
            </div>
            <div className="rounded-xl border border-slate-200 dark:border-slate-800 p-3">
              <div className="text-[11px] text-slate-500">Active Demo</div>
              <div className="font-display text-2xl font-extrabold tabular-nums text-amber-500">
                {analytics.demoStats.active}
              </div>
            </div>
            <div className="rounded-xl border border-slate-200 dark:border-slate-800 p-3">
              <div className="text-[11px] text-slate-500">Resolved Demo</div>
              <div className="font-display text-2xl font-extrabold tabular-nums text-emerald-500">
                {analytics.demoStats.resolved}
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <div className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0B1022] p-5">
          <h3 className="font-display text-sm font-bold mb-4">Support Directory Resource Distribution</h3>
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={analytics.resourceDistribution}>
                <CartesianGrid strokeDasharray="3 3" stroke="#334155" opacity={0.3} />
                <XAxis dataKey="category" tick={{ fontSize: 10 }} />
                <YAxis allowDecimals={false} tick={{ fontSize: 11 }} />
                <Tooltip />
                <Bar dataKey="count" fill="#8B5CF6" radius={[6, 6, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0B1022] p-5">
          <h3 className="font-display text-sm font-bold mb-4">Simulated Incidents by Category</h3>
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie data={pieData} dataKey="count" nameKey="name" cx="50%" cy="50%" outerRadius={80} label>
                  {pieData.map((_, idx) => (
                    <Cell key={idx} fill={COLORS[idx % COLORS.length]} />
                  ))}
                </Pie>
                <Tooltip />
              </PieChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>
    </div>
  );
}
