
// Query pool data from Elasticsearch for pool swaps with automatic pagination
async function getPoolSwaps(poolId, startMs, stopMs, maxTotalResults = 1000000) {
    const CHUNK_SIZE = 10000; // Elasticsearch's default max per query
    let allResults = [];
    let lastSortValue = null;
    let hasMore = true;
    let totalFetched = 0;

    while (hasMore && totalFetched < maxTotalResults) {
        const query = {
            "track_total_hits": true,
            "sort": [{ "block_data.block_time": { "order": "desc" } }],
            "fields": [
                { "field": "operation_history.operation_result.keyword" },
                { "field": "account_history.account.keyword" },
                { "field": "account_history.operation_id" },
                { "field": "block_data.block_num" }
            ],
            "size": CHUNK_SIZE,
            "_source": false,
            "query": {
                "bool": {
                    "filter": [{
                            "bool": {
                                "filter": [{
                                        "multi_match": {
                                            "type": "best_fields",
                                            "query": poolId,
                                            "lenient": true
                                        }
                                    },
                                    {
                                        "bool": {
                                            "should": [{ "match": { "operation_type": "63" } }],
                                            "minimum_should_match": 1
                                        }
                                    }
                                ]
                            }
                        },
                        {
                            "range": {
                                "block_data.block_time": {
                                    "format": "strict_date_optional_time",
                                    "gte": toIsoDate(startMs),
                                    "lte": toIsoDate(stopMs)
                                }
                            }
                        },
                        { "exists": { "field": "operation_history.operation_result" } }
                    ]
                }
            }
        };

        // Add search_after for subsequent chunks
        if (lastSortValue) {
            query["search_after"] = lastSortValue;
        }

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

            // If this is the first chunk and total hits is 0, return empty array
            if (!lastSortValue && data.hits.total.value === 0) {
                return [];
            }

            const currentResults = data.hits.hits || [];
            allResults = allResults.concat(currentResults);
            totalFetched += currentResults.length;

            // Check if we need to continue
            if (currentResults.length < CHUNK_SIZE || totalFetched >= maxTotalResults) {
                hasMore = false;
            } else {
                // Get the sort value from the last document for the next search_after
                lastSortValue = currentResults[currentResults.length - 1].sort;
            }

        } catch (error) {
            throw new Error('Failed to fetch from Elasticsearch: ' + error.message);
        }
        if (lastSortValue) {
            updateProgress((1-((lastSortValue[0]-startMs)/(stopMs-startMs)))*100, 'Querying Elasticsearch...');
        }
    }

    return allResults;
}

// Parse Elasticsearch swap response to [timestamp, price, volume] format
function parseSwapHistory(hits, objects, assetA) {
    const trades = [];
    for (const hit of hits) {
        try {
            const fields = hit.fields;
            const timestamp = new Date(hit.sort[0]).getTime();

            if (!fields['operation_history.operation_result.keyword']) continue;

            const opResult = JSON.parse(
                fields['operation_history.operation_result.keyword'][0].replace(/\\\//g, '/')
            )[1];

            // opResult should contain paid and received amounts
            if (opResult.paid && opResult.received) {
                const paidPrec = 10 ** objects[opResult.paid[0].asset_id]["precision"];
                const recvPrec = 10 ** objects[opResult.received[0].asset_id]["precision"];
                const paidAmount = parseFloat(opResult.paid[0].amount) / paidPrec;
                const receivedAmount = parseFloat(opResult.received[0].amount) / recvPrec;
                if (paidAmount > 0 && receivedAmount > 0) {
                    let price;
                    if (opResult.paid[0].asset_id === assetA) {
                        price = paidAmount / receivedAmount;
                    } else {
                        price = receivedAmount / paidAmount;
                    }
                    trades.push([timestamp, price, receivedAmount / recvPrec]);
                }
            }
        } catch (error) {
            console.warn('Error parsing trade:', error);
        }
    }
    return trades;
}

// Main update function - FIXED CHART DATA APPLICATION
async function updateChart() {
    loadingCandles = true;
    const poolId = document.getElementById('pool-id').value.trim();

    if (!poolId) {
        showError('Please enter a pool ID');
        return;
    }

    document.getElementById('update-btn').disabled = true;
    setLoading(true, 'Fetching historical data...', 0);

    try {
        const poolData = await rpc.getObjects([poolId]);
        try {
            assetA = poolData[poolId]["asset_a"];
            assetB = poolData[poolId]["asset_b"];
        } catch {
            throw new Error('Invalid pool ID.');
        }
        const objects = await rpc.getObjects([assetA, assetB]);

        const timeframeSeconds = parseInt(document.getElementById('timeframe').value);

        updateProgress(0, 'Querying Elasticsearch...');
        // Query 2 weeks of history
        const now = new Date().getTime();

        const hits = await getPoolSwaps(poolId, startTime, now);

        if (hits.length === 0) {
            throw new Error('No trading history found in this timeframe.');
        }

        updateProgress(100, `Parsing ${hits.length} trades...`);
        const trades = parseSwapHistory(hits, objects, assetA);

        if (trades.length === 0) {
            throw new Error('Could not parse any valid trades from Elasticsearch data');
        }

        updateProgress(100, 'Generating candles...');
        candles = tradesToCandles(trades, timeframeSeconds);

        if (candles.length === 0) {
            throw new Error('Could not generate candles from trades');
        }

        updateProgress(100, 'Rendering chart...');

        chart.applyNewData(candles);

        const timeframeLabel = {
            60: '1m',
            300: '5m',
            900: '15m',
            1800: '30m',
            3600: '1h',
            14400: '4h',
            28800: '8h',
            86400: '1d',
            604800: '1w',
            2592000: '1mo'
        } [timeframeSeconds] || timeframeSeconds + 's';

        document.getElementById('chart-info').innerHTML = `
            <strong>Pool:</strong> ${poolId} | 
            <strong>Candles:</strong> ${candles.length} | 
            <strong>Timeframe:</strong> ${timeframeLabel} | 
            <strong>Price Range:</strong> ${Math.min(...candles.map(c => c.low)).toFixed(8)} - ${Math.max(...candles.map(c => c.high)).toFixed(8)}
        `;

        updateProgress(100, 'Complete!');
        setLoading(false);
    } catch (error) {
        console.error('Chart update error:', error);
        setLoading(false);
        showError(error.message || 'Failed to load chart data');
    } finally {
        document.getElementById('update-btn').disabled = false;
        loadingCandles = false;
    }
}



function update(event, element) {
    if (event.key === 'Enter') {
        let startTime = parseInt(new Date().getTime() - (90 * 24 * 60 * 60 * 1000));
        updateChart();
    }
    
    // Update suggestions dropdown
    updateSuggestions(element);
}

function updateSuggestions(element) {
    let suggestions = searchForPool(element.value);
    suggestions.sort((a, b) => {
        return a.length-b.length;
    });

    const dropdown = document.getElementById('pool-suggestions');
    
    // Clear existing suggestions
    dropdown.innerHTML = '';
    
    // Only show suggestions if we have results and input has content
    if (suggestions.length > 0 && element.value.trim() !== '') {
        dropdown.style.display = 'block';
        
        // Create suggestion items
        suggestions.forEach(suggestion => { // Limit to 10 suggestions
            const suggestionItem = document.createElement('div');
            suggestionItem.className = 'suggestion-item';
            suggestionItem.innerHTML = `<span style="font-family:mono">${suggestion}</span> - ${poolList[suggestion][0]}:${poolList[suggestion][1]}`;
            suggestionItem.addEventListener('click', () => {
                element.value = suggestion;
                dropdown.style.display = 'none';
                // Trigger update as if Enter was pressed
                update({key: 'Enter'}, element);
            });
            dropdown.appendChild(suggestionItem);
        });
    } else {
        dropdown.style.display = 'none';
    }
}

function setupEventListeners() {
    const poolIdElement = document.getElementById('pool-id');
    
    poolIdElement.addEventListener('keyup', e => update(e, poolIdElement));
    
    // Hide dropdowns when clicking outside
    document.addEventListener('click', (e) => {
        if (!poolIdElement.contains(e.target) && !document.getElementById('pool-suggestions').contains(e.target)) {
            document.getElementById('pool-suggestions').style.display = 'none';
        }
    });
}

setupEventListeners();
