/** Whether a getNetworkRequests read should auto-stop hooks (skipped for install-only calls). */
export function shouldAutoStopNetworkCapture(installOnly: boolean, interceptedCount: number, stop: boolean): boolean {
  if (installOnly || stop) return false;
  return interceptedCount > 0;
}

export function shouldDrainInflightBeforeStop(autoStop: boolean, inflightCount: number): boolean {
  return autoStop && inflightCount > 0;
}
