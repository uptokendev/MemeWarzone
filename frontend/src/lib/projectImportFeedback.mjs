export function projectImportFeedback(error) {
  const code = String(error?.code || '');
  if (error?.currentAuthority) {
    const address = String(error.currentAuthority);
    const short = address.length > 8 ? `${address.slice(0, 4)}...${address.slice(-4)}` : address;
    return { title: 'NOT TOKEN OWNER', message: `This token is controlled by wallet ${short}. Connect that wallet to continue.`, retry: false };
  }
  if (error?.importStage === "image") return { title: "IMAGE UPLOAD NOT COMPLETED", message: "Your project registration or review request is saved. Retry the image upload below; you do not need to import again.", retry: false };
  if (error?.code === 4001 || /user rejected|user denied|request rejected/i.test(String(error?.message || ''))) return { title: 'SIGNATURE CANCELLED', message: 'The wallet signature was cancelled. Press IMPORT to try again.', retry: false };
  if (Number(error?.status) >= 500 || error instanceof TypeError || ['AbortError','TimeoutError'].includes(error?.name) || /failed to fetch|network|timeout/i.test(String(error?.message || ''))) return { title: 'IMPORT CHECK TEMPORARILY UNAVAILABLE', message: 'We could not complete this request. Nothing has been approved by this failed check. Please retry.', retry: true };
  if (['INVALID_TOKEN','SOLANA_MINT_INVALID','NO_DEPLOYED_BYTECODE','IMPORT_IDENTITY_INVALID'].includes(code)) return { title: 'CHECK CONTRACT ADDRESS AND CHAIN', message: 'No valid token was found for this Contract Address on the selected chain. Check both and try again.', retry: false };
  if (code === 'PROJECT_IMPORTS_DISABLED') return { title: 'IMPORTS TEMPORARILY UNAVAILABLE', message: 'The import service is disabled. Please try again later.', retry: true };
  if (Number(error?.status) === 401) return { title: 'WALLET VERIFICATION REQUIRED', message: 'Your wallet authorization could not be verified. Press IMPORT and sign a fresh request.', retry: false };
  return { title: 'IMPORT NOT COMPLETED', message: String(error?.message || 'The request could not be completed. Please retry.'), retry: false };
}
