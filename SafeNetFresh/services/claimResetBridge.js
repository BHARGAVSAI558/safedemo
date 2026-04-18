/** Called from AuthContext on sign-out so claim WebSocket state cannot leak across users. */
let _resetClaims = null;

export function registerClaimResetHandler(fn) {
  _resetClaims = typeof fn === 'function' ? fn : null;
}

export function clearClaimsOnSignOut() {
  try {
    _resetClaims?.();
  } catch (_) {}
}
