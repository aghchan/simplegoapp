import { useCallback, useEffect, useMemo, useState, type MouseEvent } from "react";

export type Route = { page: "runs" } | { page: "run"; runId: string } | { page: "notFound" };

const RUN_PATH = /^\/runs\/([^/]+)\/?$/;

export function parseRoute(pathname: string): Route {
  if (pathname === "/") return { page: "runs" };
  const run = RUN_PATH.exec(pathname);
  if (run?.[1]) return { page: "run", runId: run[1] };
  return { page: "notFound" };
}

export function useRoute(): [Route, (path: string) => void] {
  const [pathname, setPathname] = useState(() => window.location.pathname);

  useEffect(() => {
    const follow = () => setPathname(window.location.pathname);
    window.addEventListener("popstate", follow);
    return () => window.removeEventListener("popstate", follow);
  }, []);

  const navigate = useCallback((path: string) => {
    window.history.pushState(null, "", path);
    setPathname(window.location.pathname);
  }, []);

  return [useMemo(() => parseRoute(pathname), [pathname]), navigate];
}

// Turns a plain click on a link to one of our own pages into navigation without a reload. Anything
// else stays the browser's: a modified click opens a tab, and other origins and paths load normally.
export function followInternalLink(event: MouseEvent, navigate: (path: string) => void): void {
  const modified = event.metaKey || event.ctrlKey || event.shiftKey || event.altKey;
  if (event.defaultPrevented || event.button !== 0 || modified) return;
  const link = event.target instanceof Element ? event.target.closest("a") : null;
  if (!link || link.target || link.hasAttribute("download")) return;
  if (link.origin !== window.location.origin || parseRoute(link.pathname).page === "notFound") {
    return;
  }
  event.preventDefault();
  navigate(link.pathname);
}
