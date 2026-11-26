const PATHS = {
  down: "M3 7l6 6 4-4 8 8M21 11v6h-6",
  up: "M3 17l6-6 4 4 8-8M21 13V7h-6",
  both: "M7 4v16M7 20l-3-3M7 20l3-3M17 20V4M17 4l-3 3M17 4l3 3",
  bands: "M3 6h18M3 18h18M3 12c3-4 6 4 9 0s6 4 9 0",
  fx: "M12 3v18M16.5 7.5c-.8-1.3-2.4-2-4.5-2-2.5 0-4 1.2-4 3 0 4.3 9 2.2 9 6.5 0 1.8-1.7 3.2-4.5 3.2-2.3 0-4-.8-5-2.2",
  clock: "M12 21a9 9 0 100-18 9 9 0 000 18zM12 7v5l3 2",
  cal: "M4 6h16v14H4zM4 10h16M8 3v4M16 3v4",
  latest: "M13 3L5 13h6l-1 8 8-10h-6l1-8z",
  pick: "M4 6h16v14H4zM4 10h16M8 3v4M16 3v4M9 15h2",
  chevL: "M15 6l-6 6 6 6",
  chevR: "M9 6l6 6-6 6",
  check: "M5 12l4 4 10-10",
  search: "M11 18a7 7 0 100-14 7 7 0 000 14zM20 20l-4-4",
  sun: "M12 17a5 5 0 100-10 5 5 0 000 10zM12 1v2M12 21v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M1 12h2M21 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4",
  moon: "M21 12.8A9 9 0 1111.2 3a7 7 0 009.8 9.8z",
  auto: "M12 21a9 9 0 100-18v18zM12 3a9 9 0 010 18",
  play: "M7 5l12 7-12 7z",
  lock: "M6 11h12v10H6zM8.5 11V7.5a3.5 3.5 0 017 0V11",
  eye: "M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12zM12 15a3 3 0 100-6 3 3 0 000 6z",
  eyeOff: "M3 3l18 18M10.6 5.1A10.4 10.4 0 0112 5c6.4 0 10 7 10 7a17.6 17.6 0 01-3.2 4.1M6.6 6.6A17 17 0 002 12s3.6 7 10 7a9.7 9.7 0 005.4-1.6M9.9 9.9a3 3 0 004.2 4.2",
  logout: "M15 4h4v16h-4M10 8l-4 4 4 4M6 12h11",
  alert: "M12 9v4M12 17v.5M10.3 3.9L2.4 18a2 2 0 001.7 3h15.8a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0z",
  panelClose: "M4 5h16v14H4zM9 5v14M15.5 9.5L13 12l2.5 2.5",
  panelOpen: "M4 5h16v14H4zM9 5v14M13 9.5l2.5 2.5-2.5 2.5",
  rsi: "M4 18h4M4 13h8M4 8h12M18 6v12M15.5 15.5L18 18l2.5-2.5",
  list: "M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01",
  plus: "M12 5v14M5 12h14",
  x: "M6 6l12 12M18 6L6 18",
  trend: "M3 20h18M4 16l4.5-5 3.5 3 7-8M15 6h4v4",
  edit: "M4 20h4L19 9l-4-4L4 16v4zM13.5 6.5l4 4",
  trash: "M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6",
  folder: "M3 6.5A1.5 1.5 0 014.5 5H9l2 2h8.5A1.5 1.5 0 0121 8.5v9a1.5 1.5 0 01-1.5 1.5h-15A1.5 1.5 0 013 17.5z",
  external: "M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 01-1 1H5a1 1 0 01-1-1V7a1 1 0 011-1h5",
};

export default function Icon({ name, size = 16, sw = 1.8, className }) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={PATHS[name]} />
    </svg>
  );
}

export function BrandMark({ size = 16, draw = false }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
      <path d="M3 7h18M3 17h18" opacity=".45" />
      <path className={draw ? "wave" : undefined} d="M3 12c3-5 6 5 9 0s6 5 9 0" />
    </svg>
  );
}
