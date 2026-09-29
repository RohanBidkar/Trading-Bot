import { useEffect, useState } from "react";
import Icon from "./Icon.jsx";

const ORDER = ["auto", "light", "dark"];
const ICONS = { auto: "auto", light: "sun", dark: "moon" };

function stored() {
  try { return localStorage.getItem("sd-theme") || "auto"; } catch { return "auto"; }
}

/** Applies the saved theme before first paint of the app, then cycles it. */
export default function ThemeToggle() {
  const [mode, setMode] = useState(stored);
  useEffect(() => {
    if (mode === "auto") document.documentElement.removeAttribute("data-theme");
    else document.documentElement.setAttribute("data-theme", mode);
    try { localStorage.setItem("sd-theme", mode); } catch { /* private window */ }
  }, [mode]);
  return (
    <button type="button" className="icon-btn" title={`Theme: ${mode}`} aria-label={`Theme: ${mode}. Change theme`}
      onClick={() => setMode(ORDER[(ORDER.indexOf(mode) + 1) % ORDER.length])}>
      <Icon name={ICONS[mode]} />
    </button>
  );
}

export function applyStoredTheme() {
  const mode = stored();
  if (mode !== "auto") document.documentElement.setAttribute("data-theme", mode);
}
