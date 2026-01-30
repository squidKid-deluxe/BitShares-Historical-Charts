// Configuration
const ELASTICSEARCH_URL = 'https://es.bitshares.dev/bitshares-*/_search';

let loadingCandles = false;
let chart = null;
var objectCache = {};
var assetList = [];
var poolList = {};
var rpc = new GrapheneRPCPool();
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

async function initChart() {
    // Properly dispose existing chart if it exists
    if (chart) {
        klinecharts.dispose('kline-container');
        chart = null;
    }

    // Initialize new chart
    chart = klinecharts.init('kline-container');

    // Set style options
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
        },
        candle: {
            type: 'candle_solid',
            bar: {
                upColor: '#30de24',
                downColor: '#ff231f',
                upBorderColor: '#30de24',
                downBorderColor: '#ff231f',
                upWickColor: '#30de24',
                downWickColor: '#ff231f'
            }
        },
    })
    // Create the volume indicator in a separate pane
    chart.createIndicator({
            name: "VOL", // built-in volume indicator
            calcParams: [], // no parameters needed
            shortName: "Volume"
        },
        false, // `false` to not overlay on candles
        {
            series: "volume", // indicate that this is a volume type
        }
    );

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


function renderChart(candles, assetA, assetB) {
    const timeframeSeconds = parseInt(document.getElementById('timeframe').value);
    const timeframeLabel = {
        60: 'minute',
        300: '5-minute',
        900: '15-minute',
        1800: '30-minute',
        3600: 'hourly',
        14400: '4-hour',
        28800: '8-hour',
        86400: 'daily',
        604800: 'weekly',
        2592000: 'monthly'
    } [timeframeSeconds] || timeframeSeconds + 's';

    chart.applyNewData(candles);

    const priceRange = `${Math.min(...candles.map(c => c.low)).toFixed(8)} - ${Math.max(...candles.map(c => c.high)).toFixed(8)}`;

    document.getElementById('chart-info').innerHTML = `
        <strong>${assetA}:${assetB}</strong> | ${candles.length} ${timeframeLabel} candles
    `
}

// Elasticsearch pagination wrapper - handles all the boilerplate
async function queryElasticsearchWithPagination(queryBuilder, startMs, stopMs, maxTotalResults = 1000000) {
    const CHUNK_SIZE = 10000;
    let allResults = [];
    let lastSortValue = null;
    let hasMore = true;
    let totalFetched = 0;

    while (hasMore && totalFetched < maxTotalResults && loadingCandles) {
        // Call the query builder with current pagination state
        const query = queryBuilder(lastSortValue);

        try {
            const response = await fetch(ELASTICSEARCH_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(query)
            });

            if (!response.ok) {
                throw new Error(`Elasticsearch error: ${response.statusText}`);
            }

            const data = await response.json();

            if (!lastSortValue && data.hits.total.value === 0) {
                return [];
            }

            const currentResults = data.hits.hits || [];
            allResults = allResults.concat(currentResults);
            totalFetched += currentResults.length;

            if (currentResults.length < CHUNK_SIZE || totalFetched >= maxTotalResults) {
                hasMore = false;
            } else {
                lastSortValue = currentResults[currentResults.length - 1].sort;
            }

            if (lastSortValue) {
                updateProgress((1 - ((lastSortValue[0] - startMs) / (stopMs - startMs))) * 100, 'Querying Elasticsearch...');
            }
        } catch (error) {
            throw new Error('Failed to fetch from Elasticsearch: ' + error.message);
        }
    }

    return allResults;
}


// Generic suggestion updater
function updateSuggestionsDropdown(inputElement, suggestionsElement, suggestions, rawSuggestions) {
    suggestionsElement.innerHTML = '';

    if (suggestions.length > 0 && inputElement.value.trim() !== '') {
        suggestionsElement.style.display = 'block';

        suggestions.forEach((suggestion, idx) => {
            const item = document.createElement('div');
            item.className = 'suggestion-item';
            item.innerHTML = suggestion;
            item.addEventListener('click', () => {
                inputElement.value = rawSuggestions ? rawSuggestions[idx] : suggestion;
                suggestionsElement.style.display = 'none';
                updateChart();
            });
            suggestionsElement.appendChild(item);
        });
    } else {
        suggestionsElement.style.display = 'none';
    }
}

// Generic click-outside handler
function setupClickOutsideHandler(inputElement, suggestionsElement) {
    document.addEventListener('click', (e) => {
        if (!inputElement.contains(e.target) && !suggestionsElement.contains(e.target)) {
            suggestionsElement.style.display = 'none';
        }
    });
}

function checkVisibleRange() {
    const timeframe = parseInt(document.getElementById('timeframe').value)
    startTime -= 50 * 2 * timeframe * 1000
    updateChart();
}

function update(event, element) {
    if (event.key === 'Enter') {
        startTime = parseInt(new Date().getTime() - (90 * 24 * 60 * 60 * 1000));
        updateChart();
        return;
    }

    // Update suggestions dropdown
    updateSuggestions(element);
}

function resetStartTime() {
    startTime = parseInt(new Date().getTime() - (90 * 24 * 60 * 60 * 1000));
    updateChart();
    loadingCandles = false;
    return;
}

async function startup() {
    // Wait for search engine to initialize
    console.log("Waiting for index...")
    while (!assetList.length) {
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    console.log("Index initialized.")


    // Event listeners
    document.getElementById('update-btn').addEventListener('click', updateChart);


    setupEventListeners();

    initChart();
    updateChart(); // Load default pool
}

startup();
