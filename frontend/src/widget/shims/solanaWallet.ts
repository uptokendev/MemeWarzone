/**
 * Widget build only (aliases "@/lib/solanaWallet"): the app's trade code asks getSolanaProvider() for
 * the wallet; in the widget that is the visitor's wallet on the host page, set by the widget.
 */
type WidgetSolanaProvider = {
  publicKey?: { toString(): string } | null;
  signTransaction?: (tx: unknown) => Promise<unknown>;
  [key: string]: unknown;
};

let provider: WidgetSolanaProvider | null = null;

export function setWidgetSolanaProvider(next: WidgetSolanaProvider | null) {
  provider = next;
}

export function getSolanaProvider(): WidgetSolanaProvider | null {
  return provider;
}
