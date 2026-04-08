import { useQuery } from '@tanstack/react-query';

import { useAuth } from '../contexts/AuthContext';
import { claims } from '../services/api';

export function usePayoutHistory() {
  const { token } = useAuth();

  return useQuery({
    queryKey: ['payoutHistory'],
    enabled: Boolean(token),
    queryFn: async () => {
      const rows = await claims.getPayouts(10);
      const list = Array.isArray(rows) ? rows : [];
      return list.filter((r) => Number(r?.amount ?? r?.payout ?? r?.payout_amount ?? 0) > 0);
    },
    staleTime: 1000 * 30,
    gcTime: 1000 * 60 * 10,
    refetchInterval: 10000,
    refetchOnMount: 'always',
    refetchOnReconnect: true,
    retry: 1,
    placeholderData: (prev) => prev ?? [],
  });
}

