// Query builder for pool swaps (AMM)
function buildPoolQuery(poolId, startMs, stopMs, lastSortValue) {
    const query = {
        "track_total_hits": true,
        "sort": [{ "block_data.block_time": { "order": "desc" } }],
        "fields": [
            { "field": "operation_history.operation_result.keyword" },
            { "field": "account_history.account.keyword" },
            { "field": "account_history.operation_id" },
            { "field": "block_data.block_num" }
        ],
        "size": 10000,
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
                        }, {
                            "bool": {
                                "should": [{ "match": { "operation_type": "63" } }],
                                "minimum_should_match": 1
                            }
                        }]
                    }
                }, {
                    "range": {
                        "block_data.block_time": {
                            "format": "strict_date_optional_time",
                            "gte": toIsoDate(startMs),
                            "lte": toIsoDate(stopMs)
                        }
                    }
                }, { "exists": { "field": "operation_history.operation_result" } }]
            }
        }
    };

    if (lastSortValue) {
        query["search_after"] = lastSortValue;
    }

    return query;
}

async function getPoolSwaps(poolId, startMs, stopMs) {
    return queryElasticsearchWithPagination(
        (lastSort) => buildPoolQuery(poolId, startMs, stopMs, lastSort),
        startMs, stopMs
    );
}

function parsePoolTrades(hits, assetA) {
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
                const paidPrec = 10 ** objectCache[opResult.paid[0].asset_id]["precision"];
                const recvPrec = 10 ** objectCache[opResult.received[0].asset_id]["precision"];
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

async function updateChart() {
    loadingCandles = true;

    setLoading(true, 'Fetching historical data...', 0);

    poolId = document.getElementById('pool-id').value.trim();

    try {
        if (!poolId) {
            showError('Please enter a pool ID');
            return;
        }

        const poolData = await rpc.getObjects([poolId]);

        try {
            assetA = poolData[poolId]["asset_a"];
            assetB = poolData[poolId]["asset_b"];
        } catch {
            showError(`Invalid pool ID: ${poolId}`);
            return;
        }

        const timeframeSeconds = parseInt(document.getElementById('timeframe').value);
        const now = new Date().getTime();

        updateProgress(0, 'Querying Elasticsearch...');

        const hits = await getPoolSwaps(poolId, startTime, now);
        const trades = parsePoolTrades(hits, assetA);
        const candles = tradesToCandles(trades, timeframeSeconds);

        renderChart(candles, objectCache[assetA].symbol, objectCache[assetB].symbol, poolId);
        updateProgress(100, 'Complete!');
    } finally {
        setLoading(false);
        loadingCandles = false;
    }
}


function updateSuggestions(element) {
    let suggestions = searchForPool(element.value);
    suggestions.sort((a, b) => a.length - b.length);
    const dropdown = document.getElementById('pool-suggestions');

    // Format suggestions with pool info
    const formattedSuggestions = suggestions.map(suggestion =>
        `<span style="font-family:mono">${suggestion}</span> - ${poolList[suggestion][0]}:${poolList[suggestion][1]}`
    );

    // Use shared helper
    updateSuggestionsDropdown(element, dropdown, formattedSuggestions, suggestions);
}

function setupEventListeners() {
    const poolIdElement = document.getElementById('pool-id');
    poolIdElement.addEventListener('keyup', e => update(e, poolIdElement));

    // Use shared helper
    setupClickOutsideHandler(poolIdElement, document.getElementById('pool-suggestions'));
}
