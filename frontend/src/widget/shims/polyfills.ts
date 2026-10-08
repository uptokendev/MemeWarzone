/**
 * Widget build only (aliases "@/polyfills"): the app assigns a global Buffer; on someone else's page the
 * widget must not touch globals. Its bundle gets Buffer injected per module instead (vite.widget.config.ts).
 */
export {};
