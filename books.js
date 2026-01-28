// Query builder for asset pair swaps (limit orders)
function buildAssetPairQuery(assetA, assetB, startMs, stopMs, lastSortValue) {
    const query = {
        "track_total_hits": true,
        "sort": [{ "block_data.block_time": { "order": "desc" } }],
        "fields": [
            { "field": "operation_history.op" },
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
                        "should": [{
                            "bool": {
                                "must": [
                                    { "term": { "operation_history.op_object.amount_to_sell.asset_id.keyword": assetA } },
                                    { "term": { "operation_history.op_object.min_to_receive.asset_id.keyword": assetB } }
                                ]
                            }
                        }, {
                            "bool": {
                                "must": [
                                    { "term": { "operation_history.op_object.amount_to_sell.asset_id.keyword": assetB } },
                                    { "term": { "operation_history.op_object.min_to_receive.asset_id.keyword": assetA } }
                                ]
                            }
                        }],
                        "minimum_should_match": 1
                    }
                }, {
                    "bool": {
                        "should": [{ "match": { "operation_type": "1" } }],
                        "minimum_should_match": 1
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

// Clean wrapper function
async function getAssetPairSwaps(assetA, assetB, startMs, stopMs) {
    return queryElasticsearchWithPagination(
        (lastSort) => buildAssetPairQuery(assetA, assetB, startMs, stopMs, lastSort),
        startMs, stopMs
    );
}

function parseAssetPairTrades(hits, assetA) {
    const trades = [];
    for (const hit of hits) {
        try {
            const fields = hit.fields;
            const timestamp = new Date(hit.sort[0]).getTime();

            if (!fields['operation_history.op']) continue;

            const opResult = JSON.parse(
                fields['operation_history.op'][0].replace(/\\\//g, '/')
            )[1];

            // opResult should contain amount_to_sell and min_to_receive amounts
            if (opResult.amount_to_sell && opResult.min_to_receive) {
                const paidPrec = 10 ** objectCache[opResult.amount_to_sell.asset_id]["precision"];
                const recvPrec = 10 ** objectCache[opResult.min_to_receive.asset_id]["precision"];
                const paidAmount = parseFloat(opResult.amount_to_sell.amount) / paidPrec;
                const receivedAmount = parseFloat(opResult.min_to_receive.amount) / recvPrec;
                if (paidAmount > 0 && receivedAmount > 0) {
                    let price;
                    if (opResult.amount_to_sell.asset_id === assetA) {
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

    document.getElementById('update-btn').disabled = true;
    setLoading(true, 'Fetching historical data...', 0);

    assetA = document.getElementById('asset-a').value.trim();
    assetB = document.getElementById('asset-b').value.trim();

    let objects = await rpc.getObjectsByName([assetA, assetB])

    try {
        assetA = objects[assetA]["id"]
    } catch {
        showError('Invalid asset A.');
        return;
    }
    try {
        assetB = objects[assetB]["id"]
    } catch {
        showError('Invalid asset B.');
        return;
    }

    const timeframeSeconds = parseInt(document.getElementById('timeframe').value);
    const now = new Date().getTime();

    updateProgress(0, 'Querying Elasticsearch...');

    const hits = await getAssetPairSwaps(assetA, assetB, startTime, now);
    const trades = parseAssetPairTrades(hits, assetA);
    const candles = tradesToCandles(trades, timeframeSeconds);
    renderChart(candles, assetA, assetB);

    updateProgress(100, 'Complete!');
    setLoading(false);
    document.getElementById('update-btn').disabled = false;
    loadingCandles = false;
}

function updateSuggestions(element) {
    const suggestions = searchForAsset(element.value);
    const dropdownId = element.id === 'asset-a' ? 'asset-a-suggestions' : 'asset-b-suggestions';
    const dropdown = document.getElementById(dropdownId);

    // Use shared helper
    updateSuggestionsDropdown(element, dropdown, suggestions);
}

function setupEventListeners() {
    const assetA = document.getElementById('asset-a');
    const assetB = document.getElementById('asset-b');

    assetA.addEventListener('keyup', e => update(e, assetA));
    assetB.addEventListener('keyup', e => update(e, assetB));

    // Use shared helper
    setupClickOutsideHandler(assetA, document.getElementById('asset-a-suggestions'));
    setupClickOutsideHandler(assetB, document.getElementById('asset-b-suggestions'));
}
