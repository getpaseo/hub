import { PASEO_HUB_MARK_PATH } from "./paths.js";

/**
 * Paseo Hub SVG favicon: the canonical white five-petal flower mark on a black rounded tile
 * so the tab icon keeps contrast on both light and dark browser chrome.
 */
export const FAVICON_SVG = [
  '<svg width="48" height="48" viewBox="0 0 700 700" fill="none" xmlns="http://www.w3.org/2000/svg">',
  '  <rect width="700" height="700" rx="156" fill="#000000" />',
  `  <path transform="translate(350,350) scale(1.05) translate(-350,-350)" d="${PASEO_HUB_MARK_PATH}" stroke="#FFFFFF" stroke-width="50" stroke-linecap="round" stroke-linejoin="round" />`,
  "</svg>",
  "",
].join("\n");
