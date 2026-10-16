/**
 * The gen-8 receipt poll (app read provider, and the partner widget's status request).
 * A read that never returns used to sit forever: the deadline was only checked after the read came back,
 * so the next 250 ms tick stayed possible. This waits at most `timeoutMs` for the whole poll.
 * The in-flight read is abandoned at that deadline, its timer is cleared, and `read` is not called again.
 * The same stop happens on the first value `isDone` accepts: no pause, no further read.
 */

function receiptTimeout() {
  const error = new Error("The transaction was not confirmed in time.");
  error.code = "GEN8_RECEIPT_TIMEOUT";
  return error;
}

/** One read, raced against the time still left. A late result after the deadline is dropped. */
function readWithin(read, remaining) {
  const controller = new AbortController();
  let timer = null;
  let settled = false;
  return new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      controller.abort();
      reject(receiptTimeout());
    }, remaining);
    Promise.resolve()
      .then(() => read(controller.signal))
      .then(
        (value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(error);
        },
      );
  });
}

export async function pollGen8Receipt(read, { timeoutMs, intervalMs, sleep = null, isDone }) {
  if (!(timeoutMs > 0) || !(intervalMs > 0)) throw new Error("The receipt poll needs a timeout.");
  const pause = sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw receiptTimeout();
    const value = await readWithin(read, remaining);
    if (isDone(value)) return value;
    const gap = Math.min(intervalMs, deadline - Date.now());
    if (gap <= 0) throw receiptTimeout();
    await pause(gap);
  }
}
