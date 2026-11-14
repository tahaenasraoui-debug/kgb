import { useEffect, useState } from "react";

/** SHA-256 hex of bytes, computed off the critical path. Empty while pending. */
export function useSha256(data: Uint8Array | null): string {
  const [sha, setSha] = useState("");
  useEffect(() => {
    if (!data) {
      setSha("");
      return;
    }
    if (typeof crypto === "undefined" || !crypto.subtle) {
      setSha("unavailable (insecure context)");
      return;
    }
    let cancel = false;
    const snapshot = data;
    crypto.subtle
      .digest("SHA-256", new Uint8Array(snapshot))
      .then((buf) => {
        if (cancel) return;
        setSha(
          Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join(""),
        );
      })
      .catch(() => {
        if (!cancel) setSha("unavailable");
      });
    return () => {
      cancel = true;
    };
  }, [data]);
  return sha;
}
