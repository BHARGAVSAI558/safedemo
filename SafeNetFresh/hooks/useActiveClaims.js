import { useQuery } from '@tanstack/react-query';

import { useAuth } from '../contexts/AuthContext';
import { claims } from '../services/api';

export function useActiveClaims() {
  const { token } = useAuth();

  return useQuery({
    queryKey: ['activeClaims'],
    enabled: Boolean(token),
    queryFn: async () => {
      return await claims.getActive();
    },
    staleTime: 1000 * 15,
  });
}

