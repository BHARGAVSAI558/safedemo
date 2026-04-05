import React, { createContext, useCallback, useContext, useMemo, useReducer } from 'react';

const ClaimContext = createContext(null);

const initialState = {
  activeClaims: [],
  payoutHistory: [],
  lastClaimUpdate: null,
  disruptionAlert: null,
  premiumDue: null,
};

function reducer(state, action) {
  switch (action.type) {
    case 'CLAIM_UPDATE_RECEIVED': {
      const { claimUpdate } = action;
      const claimId = claimUpdate?.claim_id ?? claimUpdate?.claimId;
      const status = claimUpdate?.status ?? claimUpdate?.state;
      const terminalStatuses = new Set([
        'PAYOUT_DONE',
        'PAYOUT_CREDITED',
        'NO_PAYOUT',
        'DECISION_REJECTED',
        'CLAIM_REJECTED',
        'ERROR',
        'APPROVED',
        'BLOCKED',
      ]);
      const shouldBeActive = claimId ? !terminalStatuses.has(String(status)) : false;

      let nextActive = state.activeClaims;
      if (claimId) {
        const existing = state.activeClaims.filter((c) => (c?.id ?? c?.claim_id ?? c?.claimId) !== claimId);
        if (shouldBeActive) {
          nextActive = [
            ...existing,
            {
              id: claimId,
              claim_id: claimId,
              status,
              message: claimUpdate?.message,
              payout_amount: claimUpdate?.payout_amount ?? null,
              created_at: claimUpdate?.timestamp ?? claimUpdate?.created_at ?? new Date().toISOString(),
            },
          ];
        } else {
          nextActive = existing;
        }
      }

      let nextPayoutHistory = state.payoutHistory;
      const payoutAmount = claimUpdate?.payout_amount ?? claimUpdate?.payoutAmount ?? null;
      if (claimId && payoutAmount !== null && payoutAmount !== undefined) {
        const entry = {
          id: claimId,
          claim_id: claimId,
          decision: claimUpdate?.status ?? 'PAID',
          payout: payoutAmount,
          created_at: claimUpdate?.timestamp ?? claimUpdate?.created_at ?? new Date().toISOString(),
          raw: claimUpdate,
        };
        nextPayoutHistory = [entry, ...(state.payoutHistory || [])].slice(0, 20);
      }

      return {
        ...state,
        lastClaimUpdate: claimUpdate,
        activeClaims: Array.isArray(action.activeClaims) ? action.activeClaims : nextActive,
        payoutHistory: nextPayoutHistory,
      };
    }
    case 'SET_DISRUPTION_ALERT':
      return { ...state, disruptionAlert: action.alert };
    case 'CLEAR_DISRUPTION_ALERT':
      return { ...state, disruptionAlert: null };
    case 'SET_PREMIUM_DUE':
      return { ...state, premiumDue: action.alert };
    case 'CLEAR_PREMIUM_DUE':
      return { ...state, premiumDue: null };
    case 'SET_PAYOUT_HISTORY':
      return { ...state, payoutHistory: action.payoutHistory || [] };
    case 'RESET':
      return initialState;
    default:
      return state;
  }
}

export function ClaimProvider({ children }) {
  const [state, dispatch] = useReducer(reducer, initialState);

  const setDisruptionAlert = useCallback((alert) => {
    dispatch({ type: 'SET_DISRUPTION_ALERT', alert });
  }, []);

  const clearDisruptionAlert = useCallback(() => {
    dispatch({ type: 'CLEAR_DISRUPTION_ALERT' });
  }, []);

  const setPremiumDue = useCallback((alert) => {
    dispatch({ type: 'SET_PREMIUM_DUE', alert });
  }, []);

  const clearPremiumDue = useCallback(() => {
    dispatch({ type: 'CLEAR_PREMIUM_DUE' });
  }, []);

  const setClaimUpdate = useCallback(
    ({ claimUpdate, activeClaims }) => {
      dispatch({ type: 'CLAIM_UPDATE_RECEIVED', claimUpdate, activeClaims });
    },
    [dispatch]
  );

  const resetClaims = useCallback(() => {
    dispatch({ type: 'RESET' });
  }, []);

  const value = useMemo(
    () => ({
      ...state,
      setDisruptionAlert,
      clearDisruptionAlert,
      setPremiumDue,
      clearPremiumDue,
      setClaimUpdate,
      resetClaims,
      dispatch,
    }),
    [state, setDisruptionAlert, clearDisruptionAlert, setPremiumDue, clearPremiumDue, setClaimUpdate, resetClaims]
  );

  return <ClaimContext.Provider value={value}>{children}</ClaimContext.Provider>;
}

export function useClaims() {
  const ctx = useContext(ClaimContext);
  if (!ctx) throw new Error('useClaims must be used within ClaimProvider');
  return ctx;
}

