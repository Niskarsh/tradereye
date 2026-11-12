import type { Theme, TimeOpts } from './types';

/** Dark theme, close to TradingView's dark chart. Pass your own to `new Chart(el, { theme })`. */
export const DARK: Theme = {
  bg: '#0A1118', grid: 'rgba(52,72,94,0.35)', text: '#C9D1DC', textMuted: '#7C8899', axisLine: '#243446', crosshair: '#7C8899',
  up: '#1DC995', down: '#E03F53', upWick: '#1DC995', downWick: '#E03F53', volUp: 'rgba(29,201,149,0.35)', volDown: 'rgba(224,63,83,0.35)',
  line: '#DFB15B', accent: '#DFB15B', selection: '#DFB15B', panelBg: '#111B26', panelBorder: '#34485E',
  font: '11px -apple-system, BlinkMacSystemFont, "Trebuchet MS", Roboto, Ubuntu, sans-serif',
};

export const LIGHT: Theme = {
  bg: '#FFFFFF', grid: 'rgba(42,46,57,0.08)', text: '#131722', textMuted: '#787B86', axisLine: '#D1D4DC', crosshair: '#9598A1',
  up: '#089981', down: '#F23645', upWick: '#089981', downWick: '#F23645', volUp: 'rgba(8,153,129,0.4)', volDown: 'rgba(242,54,69,0.4)',
  line: '#2962FF', accent: '#2962FF', selection: '#2962FF', panelBg: '#FFFFFF', panelBorder: '#D1D4DC',
  font: '11px -apple-system, BlinkMacSystemFont, "Trebuchet MS", Roboto, Ubuntu, sans-serif',
};

/** NSE: IST, 09:15 to 15:30. */
export const NSE: TimeOpts = { tzOffsetSec: 19800, sessionOpenMin: 555, sessionCloseMin: 930 };

/** Colours offered for drawings and indicator plots (TradingView's palette order: bright first). */
export const PALETTE = [
  '#DFB15B', '#1DC995', '#E03F53', '#8FA8C2', '#E8873A', '#E8EAF0', '#2962FF', '#9C27B0', '#00BCD4', '#FFEB3B', '#FF9800', '#787B86',
];
