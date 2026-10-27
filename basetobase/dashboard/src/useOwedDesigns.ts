import { useEffect, useState } from "react";
import type { OwedDesign } from "../../shared/src/types.ts";
import { getJson, navigateTo, SIGN_IN_URL, SignedOutError } from "./api.ts";

// The PRs whose design the owner bypassed and which has yet to land. Fetched again whenever
// `refreshKey` changes: the runs list changing is what adds a PR here or clears one. A failed
// fetch keeps the last list, and a slower answer to an older key is dropped.
export function useOwedDesigns(refreshKey: unknown): OwedDesign[] {
  const [owed, setOwed] = useState<OwedDesign[]>([]);

  useEffect(() => {
    let current = true;
    getJson<OwedDesign[]>("/api/owed-designs").then(
      (list) => {
        if (current) setOwed(list);
      },
      (error: unknown) => {
        if (current && error instanceof SignedOutError) navigateTo(SIGN_IN_URL);
      },
    );
    return () => {
      current = false;
    };
  }, [refreshKey]);

  return owed;
}
