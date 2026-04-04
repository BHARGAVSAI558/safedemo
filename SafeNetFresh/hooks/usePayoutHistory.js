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
      return Array.isArray(rows) ? rows : [];
    },
    staleTime: 1000 * 30,
    retry: 1,
  });
}

