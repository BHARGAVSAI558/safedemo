import React from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import AdminLayout from './layouts/AdminLayout';
import Login from './pages/Login';
import AdminLogin from './pages/AdminLogin';
import { useAuthStore } from './stores/auth';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 60_000,
      gcTime: 10 * 60_000,
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

function PageSkeleton() {
  return (
    <div style={{ padding: '24px 8px', maxWidth: 900 }}>
      <div
        style={{
          height: 28,
          width: 280,
          borderRadius: 8,
          background: 'linear-gradient(90deg, #e2e8f0 25%, #f1f5f9 50%, #e2e8f0 75%)',
          backgroundSize: '200% 100%',
          animation: 'adminShimmer 1.2s ease-in-out infinite',
        }}
      />
      <div style={{ height: 14, width: 420, marginTop: 12, borderRadius: 6, background: '#e2e8f0' }} />
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))',
          gap: 16,
          marginTop: 28,
        }}
      >
        {[1, 2, 3, 4].map((i) => (
          <div
            key={i}
            style={{
              height: 100,
              borderRadius: 14,
              border: '1px solid var(--admin-border)',
              background: 'var(--admin-surface)',
            }}
          />
        ))}
      </div>
      <style>{`
        @keyframes adminShimmer {
          0% { background-position: 100% 0; }
          100% { background-position: -100% 0; }
        }
      `}</style>
    </div>
  );
}
const Dashboard = React.lazy(() => import('./pages/Dashboard'));
const Workers = React.lazy(() => import('./pages/Workers'));
const ZoneHeatmap = React.lazy(() => import('./pages/ZoneHeatmap'));
const FraudInsights = React.lazy(() => import('./pages/FraudInsights'));
const SupportQueries = React.lazy(() => import('./pages/SupportQueries'));
const PoolHealth = React.lazy(() => import('./pages/PoolHealth'));
const Claims = React.lazy(() => import('./pages/Claims'));
const Simulations = React.lazy(() => import('./pages/Simulations'));

function PrivateRoute({ children }: { children: React.ReactNode }) {
  const jwt = useAuthStore((s) => s.jwt);
  const expiresAtMs = useAuthStore((s) => s.expiresAtMs);
  const signOut = useAuthStore((s) => s.signOut);

  const now = Date.now();
  const expired = Boolean(jwt && expiresAtMs && expiresAtMs <= now);

  React.useEffect(() => {
    if (expired) signOut();
  }, [expired, signOut]);

  if (!jwt || expired) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/admin-login" element={<AdminLogin />} />
          <Route
            path="/"
            element={
              <PrivateRoute>
                <AdminLayout />
              </PrivateRoute>
            }
          >
            <Route index element={<React.Suspense fallback={<PageSkeleton />}><Dashboard /></React.Suspense>} />
            <Route path="zones" element={<React.Suspense fallback={<PageSkeleton />}><ZoneHeatmap /></React.Suspense>} />
            <Route path="workers" element={<React.Suspense fallback={<PageSkeleton />}><Workers /></React.Suspense>} />
            <Route path="fraud" element={<React.Suspense fallback={<PageSkeleton />}><FraudInsights /></React.Suspense>} />
            <Route path="pool-health" element={<React.Suspense fallback={<PageSkeleton />}><PoolHealth /></React.Suspense>} />
            <Route path="claims" element={<React.Suspense fallback={<PageSkeleton />}><Claims /></React.Suspense>} />
            <Route path="simulations" element={<React.Suspense fallback={<PageSkeleton />}><Simulations /></React.Suspense>} />
            <Route path="support" element={<React.Suspense fallback={<PageSkeleton />}><SupportQueries /></React.Suspense>} />
          </Route>
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  );
}

