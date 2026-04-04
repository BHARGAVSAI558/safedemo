import React, { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';

import { policies } from '../services/api';
import { useAuth } from '../contexts/AuthContext';
import { usePolicy } from '../contexts/PolicyContext';

export default function PolicyBootstrap() {
  const { token, userId } = useAuth();
  const { setPolicy } = usePolicy();

  const policyQuery = useQuery({
    queryKey: ['policy', 'current'],
    enabled: Boolean(token),
    queryFn: async () => policies.getCurrent(),
    staleTime: 1000 * 30,
    refetchInterval: 1000 * 60,
  });

  useEffect(() => {
    if (policyQuery.data) {
      setPolicy(policyQuery.data, policyQuery.data?.status);
      const isActive = String(policyQuery.data?.status || '').toLowerCase() === 'active';
      void (async () => {
        try {
          const { syncDeviceTelemetryToPolicy } = await import('../services/device_fingerprint.service');
          await syncDeviceTelemetryToPolicy({ workerId: userId, policyActive: isActive });
        } catch (_) {}
      })();
    } else {
      void (async () => {
        try {
          const { syncDeviceTelemetryToPolicy } = await import('../services/device_fingerprint.service');
          await syncDeviceTelemetryToPolicy({ workerId: userId, policyActive: false });
        } catch (_) {}
      })();
    }
  }, [policyQuery.data, setPolicy, userId]);

  return null;
}

