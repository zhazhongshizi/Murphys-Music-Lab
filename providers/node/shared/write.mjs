// A single logical operation, with a synchronous last-moment session guard.
// No catch path submits again. Unknown effects are never guessed from counts.
export const pendingWrite = () => ({ status: 'verificationPending', affectedCount: null });
export const verifiedWrite = () => ({ status: 'applied', affectedCount: null });
export function writeContext(provider, epoch, account, fail) {
  if (!account) fail('authentication_required');
  let sent = false;
  const check = () => {
    if (provider.epoch !== epoch || !account || provider.account?.id !== account) fail('cancelled');
  };
  return { check, beforeSend() { check(); sent = true; }, get sent() { return sent; } };
}
