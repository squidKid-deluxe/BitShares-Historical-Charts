// Configuration
const ELASTICSEARCH_URL = 'https://es.bitshares.dev/bitshares-*/_search';

let loadingCandles = false;
let chart = null;
let rpc = new GrapheneRPCPool();
let candles;
let startTime = parseInt(new Date().getTime() - (90 * 24 * 60 * 60 * 1000));


// Utility: Convert milliseconds to ISO date string
function toIsoDate(ms) {
    return new Date(ms).toISOString();
}

// Utility: Show error
function showError(message) {
    const errorDiv = document.getElementById('error-message');
    errorDiv.textContent = message;
    errorDiv.classList.add('active');
    setTimeout(() => {
        errorDiv.classList.remove('active');
    }, 5000);
}

// Utility: Show/hide loading
function setLoading(show, text = '', progress = 0) {
    const overlay = document.getElementById('loading-overlay');
    if (show) {
        document.getElementById('loading-text').textContent = text || 'Loading...';
        document.getElementById('progress-fill').style.width = progress + '%';
        document.getElementById('progress-text').textContent = '';
        overlay.classList.add('active');
    } else {
        overlay.classList.remove('active');
    }
}

// Utility: Update progress
function updateProgress(percent, text = '') {
    document.getElementById('progress-fill').style.width = percent + '%';
    if (text) {
        document.getElementById('progress-text').textContent = text;
    }
}

// Initialize KLineChart - FIXED
async function initChart() {
    // Properly dispose existing chart if it exists
    if (chart) {
        klinecharts.dispose('kline-container');
        chart = null;
    }

    // Initialize new chart
    chart = klinecharts.init('kline-container');

    // Set style options using CORRECT method and structure
    chart.setStyles({
        grid: {
            show: true,
            horizontal: {
                show: true,
                size: 1,
                color: '#EDEDED'
            },
            vertical: {
                show: true,
                size: 1,
                color: '#EDEDED'
            }
        }
    });

    return chart;
}

// Convert discrete trades to OHLC candles - FIXED DATA FORMAT
function tradesToCandles(trades, timeframeSeconds) {
    if (!trades || trades.length === 0) return [];

    const timeframeMs = timeframeSeconds * 1000;

    // Sort trades by timestamp to ensure chronological processing
    const sortedTrades = [...trades].sort((a, b) => a[0] - b[0]);

    // First pass: create candles only for periods with trades (original logic)
    const candleMap = new Map();

    for (const [timestamp, price, volume] of sortedTrades) {
        const candleTime = Math.floor(timestamp / timeframeMs) * timeframeMs;

        if (!candleMap.has(candleTime)) {
            candleMap.set(candleTime, {
                timestamp: candleTime,
                open: price,
                high: price,
                low: price,
                close: price,
                volume: volume
            });
        } else {
            const candle = candleMap.get(candleTime);
            candle.high = Math.max(candle.high, price);
            candle.low = Math.min(candle.low, price);
            candle.close = price;
            candle.volume += volume;
        }
    }

    // Convert to array and sort by timestamp
    const candlesWithTrades = Array.from(candleMap.values()).sort((a, b) => a.timestamp - b.timestamp);

    if (candlesWithTrades.length === 0) return [];

    // Get the full time range
    const firstTimestamp = candlesWithTrades[0].timestamp;
    const lastTimestamp = candlesWithTrades[candlesWithTrades.length - 1].timestamp;

    // Second pass: fill in empty candles with carry-forward logic
    const allCandles = [];
    let currentIndex = 0;
    let currentTime = firstTimestamp;
    let lastClose = null;

    while (currentTime <= lastTimestamp) {
        const existingCandle = candlesWithTrades[currentIndex];

        if (existingCandle && existingCandle.timestamp === currentTime) {
            // This time period has trades - use the existing candle
            allCandles.push(existingCandle);
            lastClose = existingCandle.close;
            currentIndex++;
        } else {
            // Empty candle - fill with carry-forward from last known close
            if (lastClose !== null) {
                allCandles.push({
                    timestamp: currentTime,
                    open: lastClose,
                    high: lastClose,
                    low: lastClose,
                    close: lastClose,
                    volume: 0
                });
            } else {
                // Edge case: first candle is empty (shouldn't happen with real data)
                allCandles.push({
                    timestamp: currentTime,
                    open: 0,
                    high: 0,
                    low: 0,
                    close: 0,
                    volume: 0
                });
            }
        }

        currentTime += timeframeMs;
    }

    return allCandles;
}

let prevFrom = -1;

function checkVisibleRange() {
    const timeframe = parseInt(document.getElementById('timeframe').value)
    startTime -= 50 * 2 * timeframe * 1000
    updateChart();
}

// Event listeners
document.getElementById('update-btn').addEventListener('click', updateChart);


// Initialize on load
window.addEventListener('load', () => {
    initChart();
    updateChart(); // Load default pool
});
