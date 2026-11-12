/** One candle. `t` is the bar's open time in Unix seconds (UTC). */
export interface Bar { t: number; o: number; h: number; l: number; c: number; v: number }

export type ChartType = 'candles' | 'hollow' | 'bars' | 'line' | 'area' | 'heikin';
export type ScaleMode = 'linear' | 'log' | 'percent';

/**
 * An interval: minutes (1, 3, 5, 10, 15, 30, 60, 120, 240) or a day-based one.
 * Written the TradingView way: '1', '5', '10', '60', 'D', 'W', 'M'.
 */
export type Interval = string;

export interface Theme {
  bg: string; grid: string; text: string; textMuted: string; axisLine: string; crosshair: string;
  up: string; down: string; upWick: string; downWick: string; volUp: string; volDown: string;
  line: string; accent: string; selection: string; panelBg: string; panelBorder: string; font: string;
}

export interface TimeOpts {
  /** offset of the exchange's time zone from UTC in seconds (IST = 19800) */
  tzOffsetSec: number;
  /** session open / close, minutes after local midnight (NSE: 555 = 09:15, 930 = 15:30) */
  sessionOpenMin: number;
  sessionCloseMin: number;
}

/** A point a drawing is pinned to: a time (bar open, Unix s) and a price. Times survive a change of interval. */
export interface Anchor { t: number; p: number }

export interface DrawingStyle {
  color: string; width: number; dash: 'solid' | 'dashed' | 'dotted';
  fill?: string; text?: string; fontSize?: number; extendLeft?: boolean; extendRight?: boolean; showLabels?: boolean;
}
export interface Drawing { id: string; type: string; points: Anchor[]; style: DrawingStyle; locked?: boolean; hidden?: boolean }

/** A saved indicator on a chart. */
export interface IndicatorState {
  id: string; defId: string; inputs: Record<string, number | string | boolean>;
  /** per plot: colour, width, shown */
  plots: Record<string, { color: string; width: number; visible: boolean }>;
  visible: boolean;
  /** which pane: 'main' or the id of its own pane */
  pane: string;
}

export interface PaneState { id: string; ratio: number }

/** Everything about a chart that is worth saving (not the data, not the drawings: those belong to a symbol). */
export interface ChartState {
  type: ChartType; scaleMode: ScaleMode; indicators: IndicatorState[]; panes: PaneState[]; showVolume?: boolean;
}

/** Things the app pins to a chart that are not the user's drawings (signals, trade levels). Grouped in layers so a layer can be hidden. */
export interface Marker { id?: string; t: number; position: 'above' | 'below' | 'price'; price?: number; text?: string; color: string; shape?: 'arrowUp' | 'arrowDown' | 'circle' | 'square' | 'diamond'; tooltip?: string }
export interface Level { price: number; color: string; label?: string; dash?: 'solid' | 'dashed' | 'dotted'; width?: number; from?: number; to?: number }
export interface Zone { from: number; to: number; top: number; bottom: number; color: string; label?: string }
export interface Annotations { markers?: Marker[]; levels?: Level[]; zones?: Zone[] }

export interface CompareSeries { id: string; label: string; bars: Bar[]; color: string }

export type ChartEvent =
  | { type: 'crosshair'; t: number | null; price?: number }
  | { type: 'needHistory'; before: number }
  | { type: 'stateChange' }
  | { type: 'drawingsChange' }
  | { type: 'toolDone' }
  | { type: 'select'; drawing: Drawing | null }
  | { type: 'focus' }
  | { type: 'markerClick'; marker: Marker };
