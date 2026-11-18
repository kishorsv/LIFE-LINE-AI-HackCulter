import { ActiveView } from '../types/lifeline.ts';
import { prefetchPublicJson } from './clientCache.ts';

const prefetchedViews = new Set<ActiveView>();

export function prefetchViewResources(view: ActiveView) {
  if (!prefetchedViews.has(view)) {
    prefetchedViews.add(view);
    switch (view) {
      case 'dashboard':
        void import('../components/UserDashboard.tsx');
        break;
      case 'incidents':
        void import('../components/LiveIncidentsPage.tsx');
        break;
      case 'map':
        void import('../components/LiveMapPage.tsx');
        break;
      case 'pulse':
        void import('../components/PulseHub.tsx');
        break;
      case 'agents':
        void import('../components/AiAgentsHub.tsx');
        break;
      case 'operator':
        void import('../components/OperatorDashboard.tsx');
        break;
      case 'profile':
        void import('../components/ProfileSettings.tsx');
        break;
      default:
        break;
    }
  }

  // Opportunistically warm shared public JSON endpoints
  if (view === 'map' || view === 'dashboard' || view === 'pulse' || view === 'incidents') {
    prefetchPublicJson('public:support-directory:all:', '/api/support-directory', 60_000);
  }
  if (view === 'incidents') {
    prefetchPublicJson('public:live-incidents:mysuru', '/api/live-incidents?region=mysuru', 20_000);
  }
  if (view === 'pulse') {
    prefetchPublicJson('public:pulse-reports', '/api/pulse/reports', 15_000);
  }
}
