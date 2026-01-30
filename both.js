// Generate varying shades of blue for pool lines
function generateBlueShades(count) {
    const shades = [];
    // Base BitShares blue: #007bff (rgb: 0, 123, 255)
    // We'll vary the lightness from dark to light
    for (let i = 0; i < count; i++) {
        const lightness = 30 + (i / (count - 1 || 1)) * 50; // 30% to 80% lightness
        shades.push(`hsl(210, 100%, ${lightness}%)`);
    }
    return shades;
}

// Find all pools that contain the given asset pair
function findPoolsForPair(assetAId, assetBId) {
    const matchingPools = [];
    
    for (const [poolId, poolData] of Object.entries(objectCache)) {
        if (!poolId.startsWith('1.19.')) continue;
        
        const poolAssetA = poolData.asset_a;
        const poolAssetB = poolData.asset_b;
        
        // Check if this pool matches the pair (in either direction)
        if ((poolAssetA === assetAId && poolAssetB === assetBId) ||
            (poolAssetA === assetBId && poolAssetB === assetAId)) {
            matchingPools.push(poolId);
        }
    }
    
    return matchingPools;
}

// Synchronize multiple candle arrays to cover the same time range
function synchronizeMultipleCandles(allCandlesArrays, timeframeSeconds) {
    if (allCandlesArrays.length === 0 || allCandlesArrays.every(arr => arr.length === 0)) {
        return allCandlesArrays;
    }
    
    const timeframeMs = timeframeSeconds * 1000;
    
    // Find overall time range across all datasets
    let minTimestamp = Infinity;
    let maxTimestamp = -Infinity;
    
    for (const candles of allCandlesArrays) {
        if (candles.length > 0) {
            minTimestamp = Math.min(minTimestamp, candles[0].timestamp);
            maxTimestamp = Math.max(maxTimestamp, candles[candles.length - 1].timestamp);
        }
    }
    
    // Pad each array to cover the full range
    return allCandlesArrays.map(candles => {
        if (candles.length === 0) {
            // If no data, create empty candles
            const emptyCandles = [];
            for (let t = minTimestamp; t <= maxTimestamp; t += timeframeMs) {
                emptyCandles.push({
                    timestamp: t,
                    open: 0,
                    high: 0,
                    low: 0,
                    close: 0,
                    volume: 0
                });
            }
            return emptyCandles;
        }
        
        const firstPrice = candles[0].close;
        const lastPrice = candles[candles.length - 1].close;
        const result = [];
        
        // Pad at the beginning
        for (let t = minTimestamp; t < candles[0].timestamp; t += timeframeMs) {
            result.push({
                timestamp: t,
                open: firstPrice,
                high: firstPrice,
                low: firstPrice,
                close: firstPrice,
                volume: 0
            });
        }
        
        // Add actual candles
        result.push(...candles);
        
        // Pad at the end
        for (let t = candles[candles.length - 1].timestamp + timeframeMs; t <= maxTimestamp; t += timeframeMs) {
            result.push({
                timestamp: t,
                open: lastPrice,
                high: lastPrice,
                low: lastPrice,
                close: lastPrice,
                volume: 0
            });
        }
        
        return result;
    });
}

// Comparison chart using existing pool and book functions
async function updateChart() {
    loadingCandles = true;
    document.getElementById('update-btn').disabled = true;
    setLoading(true, 'Fetching pool and orderbook data...', 0);

    const assetAInput = document.getElementById('asset-a').value.trim();
    const assetBInput = document.getElementById('asset-b').value.trim();

    try {
        if (!assetAInput || !assetBInput) {
            showError('Please enter both asset symbols');
            return;
        }

        updateProgress(5, 'Resolving asset symbols...');
        const objects = await rpc.getObjectsByName([assetAInput, assetBInput]);

        let assetA, assetB;
        try {
            assetA = objects[assetAInput]["id"];
        } catch {
            showError(`Invalid asset: ${assetAInput}`);
            return;
        }
        try {
            assetB = objects[assetBInput]["id"];
        } catch {
            showError(`Invalid asset: ${assetBInput}`);
            return;
        }

        const assetASymbol = objectCache[assetA].symbol;
        const assetBSymbol = objectCache[assetB].symbol;

        updateProgress(10, 'Finding matching pools...');
        const matchingPools = findPoolsForPair(assetA, assetB);
        
        if (matchingPools.length === 0) {
            showError(`No pools found for pair ${assetASymbol}:${assetBSymbol}`);
            return;
        }

        const timeframeSeconds = parseInt(document.getElementById('timeframe').value);
        const now = new Date().getTime();

        updateProgress(15, `Found ${matchingPools.length} pool(s). Querying data...`);

        // Fetch all pool data in parallel
        const poolDataPromises = matchingPools.map(async (poolId, index) => {
            const progressStart = 20 + (index / matchingPools.length) * 30;
            const progressEnd = 20 + ((index + 1) / matchingPools.length) * 30;
            
            updateProgress(progressStart, `Querying pool ${poolId}...`);
            const hits = await getPoolSwaps(poolId, startTime, now);
            
            // Get asset order for this pool
            const poolInfo = objectCache[poolId];
            const poolAssetA = poolInfo.asset_a;
            
            updateProgress(progressStart + (progressEnd - progressStart) * 0.5, `Processing pool ${poolId}...`);
            const trades = parsePoolTrades(hits, poolAssetA);
            const candles = tradesToCandles(trades, timeframeSeconds);
            
            return { poolId, candles, assetA: poolAssetA };
        });

        // Fetch orderbook data
        updateProgress(60, 'Querying orderbook data...');
        const bookHitsPromise = getAssetPairSwaps(assetA, assetB, startTime, now);

        // Wait for all data
        const [poolResults, bookHits] = await Promise.all([
            Promise.all(poolDataPromises),
            bookHitsPromise
        ]);

        updateProgress(80, 'Processing orderbook trades...');
        const bookTrades = parseAssetPairTrades(bookHits, assetA);
        const bookCandles = tradesToCandles(bookTrades, timeframeSeconds);

        updateProgress(85, 'Synchronizing time ranges...');
        
        // Extract all candle arrays
        const allCandleArrays = poolResults.map(r => r.candles);
        allCandleArrays.push(bookCandles);
        
        // Synchronize all to same range
        const synchronized = synchronizeMultipleCandles(allCandleArrays, timeframeSeconds);
        
        // Separate back out
        const syncedPoolResults = poolResults.map((r, i) => ({
            ...r,
            candles: synchronized[i]
        }));
        const syncedBookCandles = synchronized[synchronized.length - 1];

        updateProgress(95, 'Rendering comparison chart...');
        
        const poolColors = generateBlueShades(matchingPools.length);
        
        renderComparisonChart(
            syncedPoolResults,
            syncedBookCandles,
            assetASymbol,
            assetBSymbol,
            poolColors
        );

        updateProgress(100, 'Complete!');
    } catch (error) {
        console.error('Error updating chart:', error);
        showError('Failed to load data: ' + error.message);
    } finally {
        setLoading(false);
        document.getElementById('update-btn').disabled = false;
        loadingCandles = false;
    }
}

function renderComparisonChart(poolResults, bookCandles, assetASymbol, assetBSymbol, poolColors) {
    const timeframeSeconds = parseInt(document.getElementById('timeframe').value);
    const timeframeLabel = {
        60: '1 minute',
        300: '5 minutes',
        900: '15 minutes',
        1800: '30 minutes',
        3600: '1 hour',
        14400: '4 hours',
        28800: '8 hours',
        86400: '1 day',
        604800: '1 week',
        2592000: '1 month'
    }[timeframeSeconds] || timeframeSeconds + 's';

    const traces = [];
    
    // Add pool traces with varying blue shades
    poolResults.forEach((result, index) => {
        const timestamps = result.candles.map(c => new Date(c.timestamp));
        const prices = result.candles.map(c => c.close);
        
        traces.push({
            x: timestamps,
            y: prices,
            mode: 'lines',
            name: `Pool ${result.poolId}`,
            line: {
                color: poolColors[index],
                width: 2
            },
            hovertemplate: '%{x}<br>Pool ' + result.poolId + ': %{y:.8f}<extra></extra>'
        });
    });

    // Add orderbook trace in magenta
    const bookTimestamps = bookCandles.map(c => new Date(c.timestamp));
    const bookPrices = bookCandles.map(c => c.close);
    
    traces.push({
        x: bookTimestamps,
        y: bookPrices,
        mode: 'lines',
        name: 'Order Book',
        line: {
            color: '#ff00ff',
            width: 3
        },
        hovertemplate: '%{x}<br>Order Book: %{y:.8f}<extra></extra>'
    });

    const layout = {
        title: {
            text: `${assetASymbol}:${assetBSymbol} - All Pools vs Orderbook`,
            font: {
                color: '#ffffff',
                size: 18
            }
        },
        xaxis: {
            title: 'Date',
            color: '#cccccc',
            gridcolor: '#333333',
            zerolinecolor: '#333333'
        },
        yaxis: {
            title: 'Price',
            color: '#cccccc',
            gridcolor: '#333333',
            zerolinecolor: '#333333',
            tickformat: '.8f'
        },
        paper_bgcolor: '#1a1a1a',
        plot_bgcolor: '#1a1a1a',
        font: {
            color: '#cccccc'
        },
        legend: {
            font: {
                color: '#ffffff'
            },
            bgcolor: 'rgba(0,0,0,0.5)',
            orientation: 'h',
            y: -0.2
        },
        hovermode: 'x unified',
        showlegend: true,
        margin: { b: 100 }
    };

    const config = {
        responsive: true,
        displayModeBar: true,
        modeBarButtonsToRemove: ['lasso2d', 'select2d']
    };

    Plotly.newPlot('plotly-chart', traces, layout, config);

    // Build custom legend
    const legendContainer = document.getElementById('pool-legend');
    legendContainer.innerHTML = '';
    
    // Add pool legend items
    poolResults.forEach((result, index) => {
        const item = document.createElement('div');
        item.className = 'legend-item';
        item.innerHTML = `
            <div class="legend-color" style="background: ${poolColors[index]}"></div>
            <span>Pool ${result.poolId}</span>
        `;
        legendContainer.appendChild(item);
    });
    
    // Add orderbook legend item
    const bookItem = document.createElement('div');
    bookItem.className = 'legend-item';
    bookItem.innerHTML = `
        <div class="legend-color" style="background: #ff00ff"></div>
        <span>Order Book</span>
    `;
    legendContainer.appendChild(bookItem);

    // Update info text
    let infoText = `<strong>${assetASymbol}:${assetBSymbol}</strong> | ${timeframeLabel} timeframe<br>`;
    
    poolResults.forEach(result => {
        const priceRange = result.candles.length > 0 
            ? `${Math.min(...result.candles.map(c => c.low)).toFixed(8)} - ${Math.max(...result.candles.map(c => c.high)).toFixed(8)}`
            : 'N/A';
        infoText += `Pool ${result.poolId}: ${result.candles.length} candles | Range: ${priceRange}<br>`;
    });
    
    const bookPriceRange = bookCandles.length > 0
        ? `${Math.min(...bookCandles.map(c => c.low)).toFixed(8)} - ${Math.max(...bookCandles.map(c => c.high)).toFixed(8)}`
        : 'N/A';
    infoText += `Order Book: ${bookCandles.length} candles | Range: ${bookPriceRange}`;

    document.getElementById('chart-info').innerHTML = infoText;
}

function updateSuggestions(element) {
    const suggestions = searchForAsset(element.value);
    const dropdownId = element.id === 'asset-a' ? 'asset-a-suggestions' : 'asset-b-suggestions';
    const dropdown = document.getElementById(dropdownId);

    updateSuggestionsDropdown(element, dropdown, suggestions);
}

function setupEventListeners() {
    const assetA = document.getElementById('asset-a');
    const assetB = document.getElementById('asset-b');

    assetA.addEventListener('keyup', e => update(e, assetA));
    assetB.addEventListener('keyup', e => update(e, assetB));

    setupClickOutsideHandler(assetA, document.getElementById('asset-a-suggestions'));
    setupClickOutsideHandler(assetB, document.getElementById('asset-b-suggestions'));
}

function checkVisibleRange() {
    const timeframe = parseInt(document.getElementById('timeframe').value);
    startTime -= 50 * 2 * timeframe * 1000;
    updateChart();
}

async function startup() {
    console.log("Waiting for index...");
    while (!assetList.length) {
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    console.log("Index initialized.");

    document.getElementById('update-btn').addEventListener('click', updateChart);
    setupEventListeners();
    updateChart();
}

startup();