async function getNewest(type = "pool") {
    const field = (type == "pool") ? "operation_history.operation_result_object.data_object.new_objects" : "operation_history.operation_result_object.data_string";
    const query = {
        "track_total_hits": true,
        "sort": [{ "block_data.block_time": { "order": "desc" } }],
        "fields": [
            { "field": field },
        ],
        "size": 1,
        "_source": false,
        "query": {
            "bool": {
                "filter": [{
                        "bool": {
                            "should": [{ "match": { "operation_type": (type == "pool") ? "59" : "10" } }],
                            "minimum_should_match": 1
                        }
                    },
                    { "exists": { "field": "operation_history.operation_result" } }
                ]
            }
        }
    };

    let latest;

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

        latest = data.hits.hits[0].fields[field][0];

    } catch (error) {
        throw new Error('Failed to fetch from Elasticsearch: ' + error.message);
    }

    return parseInt(latest.split(".")[2]);
}

async function loadDataIndex() {

    setLoading(true, 'Fetching latest assets...', 0);
    const latestPoolIndex = await getNewest("pool");
    const latestAssetIndex = await getNewest("asset");

    if (localStorage.getItem('objectCache')) {
        objectCache = JSON.parse(localStorage.getItem('objectCache'));
    }

    updateProgress(5, 'Waiting for RPC...');
    // Wait for main thread to start an rpc instance
    while (!rpc) {
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    updateProgress(20, 'Gathering pool objects...');

    const knownPoolIndex = Object.keys(objectCache).length ? Math.max(
        ...Object.keys(objectCache)
            .filter(key => key.startsWith("1.19."))
            .map(key => parseInt(key.split(".")[2]))
    ) : 0;
    const allIds = Array.from({ length: latestPoolIndex + 2 - knownPoolIndex }, (_, i) => `1.19.${i + knownPoolIndex}`);
    const validIds = await rpc.getObjects(allIds);


    updateProgress(40, 'Gathering asset objects...');
    const knownAssetIndex = Object.keys(objectCache).length ? Math.max(
        ...Object.keys(objectCache)
            .filter(key => key.startsWith("1.3."))
            .map(key => parseInt(key.split(".")[2]))
    ) : 0;
    const objectsToGet = Array.from({ length: latestAssetIndex + 2 - knownAssetIndex }, (_, i) => `1.3.${i + knownAssetIndex}`);
    const fetchedIds = { ...validIds, ...await rpc.getObjects(objectsToGet) };

    updateProgress(90, 'Parsing data...');

    const newCache = Object.fromEntries(
      Object.entries(fetchedIds).map(([key, value]) => {
        if (key.startsWith('1.3.')) {
          return [
            key,
            {
              id: value.id,
              precision: value.precision,
              symbol: value.symbol
            }
          ];
        }
        
        return [
          key,
          {
            id: value.id,
            asset_a: value.asset_a,
            asset_b: value.asset_b
          }
        ];
      })
    );

    objectCache = {...objectCache, ...newCache};

    localStorage.setItem('objectCache', JSON.stringify(objectCache));

    // Up to this point takes ~350ms

    for (object of Object.values(objectCache)) {
        if (object.id && object.id.startsWith("1.3.")) {
            assetList.push(object.symbol);
        }
    }

    for (object of Object.values(objectCache)) {
        if (object.id && object.id.startsWith("1.19.")) {
            poolList[object.id] = [objectCache[object.asset_a].symbol, objectCache[object.asset_b].symbol];
        }
    }
    setLoading(false);
}

function searchForAsset(searchTerm) {
    let results = [];
    if (!searchTerm.includes(" ")) {
        searchTerm = [searchTerm];
    } else {
        searchTerm = searchTerm.split(" ");
    }
    for (asset of assetList) {
        if (searchTerm.every(term => asset.includes(term))) {
            results.push(asset);
        }
    }
    results.sort()
    return results;
}

function searchForPool(searchTerm) {
    let results = [];
    if (searchTerm.includes(" ")) {
        const [term1, term2] = searchTerm.split(" ");

        for ([poolId, pool] of Object.entries(poolList)) {
            // for example, searching for "HONEST USD" would pull up both HONEST:USD and USD:HONEST.BTC, but not HONEST.USD:BTS
            if ((pool[0].includes(term1) && pool[1].includes(term2)) || (pool[0].includes(term2) && pool[1].includes(term1))) {
                results.push(poolId);
            }
        }
    } else {
        for ([poolId, pool] of Object.entries(poolList)) {
            if (pool[0].includes(searchTerm) || pool[1].includes(searchTerm)) {
                results.push(poolId);
            }
        }
    }
    results.sort()
    return results;
}

loadDataIndex();
