import { useEffect, useState } from "react";

// Canvas-drawn React Bits pieces (DotGrid, ClickSpark) need literal colours,
// not CSS variables, so read the tokens and re-read them when the theme flips.
export function useThemeColors(names) {
  const read = () => {
    const style = getComputedStyle(document.documentElement);
    return Object.fromEntries(names.map(n => [n, style.getPropertyValue(n).trim()]));
  };
  const [colors, setColors] = useState(read);
  useEffect(() => {
    const update = () => setColors(read());
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    media.addEventListener("change", update);
    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => { media.removeEventListener("change", update); observer.disconnect(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return colors;
}

export const REDUCED_MOTION =
  typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
