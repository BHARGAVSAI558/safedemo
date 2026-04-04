import { useQuery } from '@tanstack/react-query';

import { useAuth } from '../contexts/AuthContext';
import { workers } from '../services/api';

export function useWorkerProfile() {
  const { token, dispatch } = useAuth();

  return useQuery({
    queryKey: ['workerProfile'],
    enabled: Boolean(token),
    queryFn: async () => {
      try {
        const profile = await workers.getProfile();
        if (dispatch) dispatch({ type: 'SET_PROFILE', profile });
        return profile;
      } catch (e) {
        if (e?.response?.status === 404) {
          if (dispatch) dispatch({ type: 'SET_PROFILE_READY', ready: false });
          return null;
        }
        throw e;
      }
    },
    staleTime: 1000 * 30,
    retry: (failureCount, err) => {
      const s = err?.response?.status;
      if (s === 401 || s === 404) return false;
      return failureCount < 2;
    },
  });
}

