# candle-chart

A dependency-free canvas chart for trading apps, written for tradereye and kept framework-free so it can be published
to npm. TypeScript source, no runtime dependencies.

- **Series**: candles, hollow candles, Heikin Ashi, OHLC bars, line, area; volume on the price pane
- **Scales**: regular, logarithmic, percent; drag the price / time axis to scale, double-click to reset, wheel to zoom
- **Indicators** (30+, each with settings and per-line style): MA, EMA, WMA, HMA, VWMA, EMA ribbon, Supertrend, Parabolic SAR,
  Ichimoku, Bollinger, Keltner, Donchian, ATR, VWAP (+bands), previous day H/L/C, pivots, opening range,
  volume profile (visible range), volume, relative volume at time, OBV, MFI, CMF, RSI, MACD, Stochastic, Stoch RSI, CCI,
  Williams %R, ADX/DMI, ROC, Momentum, Awesome Oscillator, Aroon, TRIX. Add your own with `registerIndicator`.
- **Drawings**: trend line, ray, extended line, arrow, horizontal line / ray, vertical line, cross line, parallel channel,
  rectangle, Fibonacci retracement, long / short position (R:R), date & price range, text, brush. Select, drag, edit
  colour / width / style, lock, clone, delete, undo / redo, magnet (weak / strong). Anchored in time, so they show on
  every interval. Add your own with `registerTool`.
- **Panes**: indicators in their own panes, resizable dividers; per-pane legends with hide / settings / remove
- **Compare**: other symbols as % lines
- **Annotations**: app-owned markers (with tooltips and click events), levels and zones in named layers that can be hidden
- **Sync**: crosshair time in / out for multi-chart layouts; screenshot to PNG

```ts
import { Chart, aggregate, NSE } from '@candlesbeforecubicles/candle-chart';

const chart = new Chart(document.getElementById('chart')!, { symbol: 'HDFCBANK', interval: '10', time: NSE });
chart.setBars(aggregate(oneMinuteBars, '10', NSE));
chart.addIndicator('vwap');
chart.on((e) => { if (e.type === 'needHistory') loadOlder(e.before).then((b) => chart.prependBars(b)); });
```

Bars are `{ t, o, h, l, c, v }` with `t` in Unix seconds. `TimeOpts` sets the exchange time zone and session
(NSE: IST, 09:15-15:30), which drives intraday bucketing (hourly bars at 09:15, 10:15, ...), session VWAP and the axis.

Tests: `tests/chart.test.ts` in tradereye.
