/**
 * The built-in RSI as Pine Script® v6, for the Pine Editor (docs/SPEC.md §5.16): our own code,
 * written to compute exactly what rsi.ts computes, with the same inputs, plots, levels and fills,
 * not TradingView's text. A test runs it against rsi.ts bar for bar (packages/pine).
 */
export const RSI_PINE = `//@version=6
indicator("Relative Strength Index", shorttitle = "RSI", format = format.price, precision = 2)

// Settings, in the order the Inputs tab lists them
length = input.int(14, "RSI Length", minval = 1, maxval = 2000, group = "RSI Settings")
source = input.source(close, "Source", group = "RSI Settings")
maType = input.string("SMA", "Type", options = ["None", "SMA", "SMA + Bollinger Bands", "EMA", "SMMA (RMA)", "WMA", "VWMA"], group = "Smoothing", display = display.none)
maLength = input.int(14, "Length", minval = 1, maxval = 10000, group = "Smoothing", display = display.none, active = maType != "None")
bbMult = input.float(2.0, "BB StdDev", minval = 0.001, maxval = 50, step = 0.5, group = "Smoothing", display = display.none, active = maType == "SMA + Bollinger Bands")

// Wilder's averages of each bar's rise and fall, and the index they make
move = ta.change(source)
avgGain = ta.rma(math.max(move, 0), length)
avgLoss = ta.rma(-math.min(move, 0), length)
rsi = avgLoss == 0 ? 100 : avgGain == 0 ? 0 : 100 - 100 / (1 + avgGain / avgLoss)

// The line that smooths the index, of the chosen type
smoothing(series float value, simple int len, simple string kind) =>
    switch kind
        "SMA" => ta.sma(value, len)
        "SMA + Bollinger Bands" => ta.sma(value, len)
        "EMA" => ta.ema(value, len)
        "SMMA (RMA)" => ta.rma(value, len)
        "WMA" => ta.wma(value, len)
        "VWMA" => ta.vwma(value, len)
        => na

smoothed = maType != "None"
banded = maType == "SMA + Bollinger Bands"
average = smoothing(rsi, maLength, maType)
spread = banded ? ta.stdev(rsi, maLength) * bbMult : na

rsiLine = plot(rsi, "RSI", color = #7E57C2)
plot(average, "RSI-based MA", color = color.yellow, display = smoothed ? display.all : display.none)
upperLine = plot(average + spread, "Upper Bollinger Band", color = color.green, display = banded ? display.all : display.none)
lowerLine = plot(average - spread, "Lower Bollinger Band", color = color.green, display = banded ? display.all : display.none)
fill(upperLine, lowerLine, color = color.new(color.green, 90), title = "Bollinger Bands Background Fill", display = banded ? display.all : display.none)

upperBand = hline(70, "RSI Upper Band", color = #787B86)
hline(50, "RSI Middle Band", color = color.new(#787B86, 50))
lowerBand = hline(30, "RSI Lower Band", color = #787B86)
fill(upperBand, lowerBand, color = color.rgb(126, 87, 194, 90), title = "RSI Background Fill")

// Beyond 70 and 30, a gradient between the index and a hidden line at 50
middle = plot(50, "Middle", display = display.none, editable = false)
fill(rsiLine, middle, 100, 70, top_color = color.new(color.green, 0), bottom_color = color.new(color.green, 100), title = "Overbought Gradient Fill")
fill(rsiLine, middle, 30, 0, top_color = color.new(color.red, 100), bottom_color = color.new(color.red, 0), title = "Oversold Gradient Fill")
`;
