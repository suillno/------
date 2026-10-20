// 글자색 팔레트 표시. 저장값(밝은 화면 색)은 기기 간 그대로 두고, 어두운 화면에서는 대비를 맞춘 색으로 보여 준다.
import { PALETTE, isPaletteColor } from "@meeting/client-core";

let injected = false;

/** 어두운 화면용 색 규칙을 한 번만 넣는다. 색 정보는 data-rt-color 속성으로 고른다. */
export function ensurePaletteStyle(): void {
  if (injected || typeof document === "undefined") return;
  injected = true;
  const rules = PALETTE.map((c) => `[data-rt-color="${c.value}"]{color:${c.dark} !important}[data-rt-swatch="${c.value}"]{background:${c.dark} !important}`).join("");
  const style = document.createElement("style");
  style.id = "rt-palette";
  style.textContent = `@media (prefers-color-scheme: dark){${rules}}`;
  document.head.appendChild(style);
}

/** rgb(…)·#rgb·#rrggbb 표기를 #rrggbb로 바꾼다. 팔레트 밖이면 null(붙여넣은 색은 버린다) */
export function toPaletteColor(value: string | null | undefined): string | null {
  if (!value) return null;
  const v = value.trim().toLowerCase();
  let hex: string | null = null;
  const rgb = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(v);
  if (rgb) hex = "#" + rgb.slice(1, 4).map((n) => Math.min(255, Number(n)).toString(16).padStart(2, "0")).join("");
  else if (/^#[0-9a-f]{6}$/.test(v)) hex = v;
  else if (/^#[0-9a-f]{3}$/.test(v)) hex = "#" + [...v.slice(1)].map((c) => c + c).join("");
  return hex && isPaletteColor(hex) ? hex : null;
}
