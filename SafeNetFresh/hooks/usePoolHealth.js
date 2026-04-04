import { useQuery } from '@tanstack/react-query';

import { useAuth } from '../contexts/AuthContext';
import { pools } from '../services/api';

export function usePoolHealth() {
  const { token } = useAuth();

  return useQuery({
    queryKey: ['poolHealth'],
    enabled: Boolean(token),
    queryFn: async () => pools.getHealth(),
    staleTime: 1000 * 60,
    refetchInterval: 1000 * 60,
  });
}

