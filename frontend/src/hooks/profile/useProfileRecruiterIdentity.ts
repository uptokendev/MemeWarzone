import { useEffect, useState } from "react";
import {
  fetchRecruiterSummaryByWallet,
  fetchSquadSummary,
  fetchWalletAttributionState,
} from "@/lib/recruiterApi";

export type ProfileRecruiterIdentity = {
  loading: boolean;
  isRecruiter: boolean;
  recruiterCode: string | null;
  recruiterName: string | null;
  squadCode: string | null;
  squadName: string | null;
};

function cleanCode(value?: string | null) {
  const raw = String(value || "").trim().replace(/^\/+/, "");
  return raw || null;
}

function cleanName(value?: string | null) {
  const raw = String(value || "").trim();
  return raw || null;
}

export function useProfileRecruiterIdentity(walletAddress?: string | null): ProfileRecruiterIdentity {
  const [state, setState] = useState<ProfileRecruiterIdentity>({
    loading: Boolean(walletAddress),
    isRecruiter: false,
    recruiterCode: null,
    recruiterName: null,
    squadCode: null,
    squadName: null,
  });

  useEffect(() => {
    let cancelled = false;
    const wallet = String(walletAddress || "").trim();
    if (!wallet) {
      setState({
        loading: false,
        isRecruiter: false,
        recruiterCode: null,
        recruiterName: null,
        squadCode: null,
        squadName: null,
      });
      return;
    }

    setState((prev) => ({ ...prev, loading: true }));
    void (async () => {
      try {
        const [recruiterResult, attributionResult] = await Promise.allSettled([
          fetchRecruiterSummaryByWallet(wallet),
          fetchWalletAttributionState(wallet),
        ]);
        if (cancelled) return;

        const recruiter = recruiterResult.status === "fulfilled" ? recruiterResult.value : null;
        const attribution = attributionResult.status === "fulfilled" ? attributionResult.value : null;
        const recruiterCode = cleanCode(recruiter?.code);
        const squadCode = cleanCode(attribution?.recruiterCode) || recruiterCode;
        let squadName = cleanName(attribution?.recruiterDisplayName);

        if (squadCode) {
          try {
            const squad = await fetchSquadSummary(squadCode);
            if (!cancelled) {
              squadName = cleanName(squad?.recruiterDisplayName) || squadName;
            }
          } catch {
            // keep attribution name / code
          }
        }

        if (cancelled) return;
        setState({
          loading: false,
          isRecruiter: Boolean(recruiterCode),
          recruiterCode,
          recruiterName: cleanName(recruiter?.displayName),
          squadCode,
          squadName,
        });
      } catch {
        if (!cancelled) {
          setState({
            loading: false,
            isRecruiter: false,
            recruiterCode: null,
            recruiterName: null,
            squadCode: null,
            squadName: null,
          });
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [walletAddress]);

  return state;
}
