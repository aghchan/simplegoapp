import type { ReactNode } from "react";

const GITHUB = "https://github.com/";

// Dispatch derives these urls, so a foreign one means something is wrong, and nothing is linked.
export function GithubLink(p: {
  href: string | undefined;
  className?: string;
  children: ReactNode;
}) {
  if (!p.href?.startsWith(GITHUB)) return null;
  return (
    <a className={p.className} href={p.href} target="_blank" rel="noopener noreferrer">
      {p.children}
      <span aria-hidden="true"> ↗</span>
    </a>
  );
}
