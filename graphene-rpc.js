/*
 * Provides a hook to a bitshares node and returns human-readable data
 */
class GrapheneRPC {
    /**
     * @param {string} url - WebSocket URL
     * @param {number} [timeout=10000] - Timeout for the connection handshake in ms
     * @param {boolean} [autoPing=true] - Whether to automatically ping the node
     */
    constructor(url, timeout = 10000, autoPing = true) {
        this.url = url;
        this.ws = null;
        this.connected = false;
        this.requestId = 1;
        this.queue = [];
        this.timeout = timeout;
        this.autoPing = autoPing;
        this.pingInterval = null;
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 10;
        this.reconnectDelay = 1000; // Start with 1 second delay
        this.lastPingTime = 0;
        this.pingLatency = 0;
        this.connectionPromise = null;
        
        // Start connection process
        this.connect();
    }

    /**
     * Attempt to connect and return a Promise that resolves on open, rejects on timeout
     * @returns {Promise<void>}
     */
    connect() {
        if (this.connectionPromise) {
            return this.connectionPromise;
        }

        this.connectionPromise = new Promise((resolve, reject) => {
            // Clean up existing connection
            if (this.ws) {
                this.ws.close();
                this.stopPing();
            }

            this.ws = new WebSocket(this.url);

            const timer = setTimeout(() => {
                if (!this.connected) {
                    this.ws.close();
                    this.handleConnectionError(new Error(`Connection timeout after ${this.timeout} ms`));
                    reject(new Error(`GrapheneRPC: Connection timeout after ${this.timeout} ms`));
                }
            }, this.timeout);

            this.ws.onopen = () => {
                clearTimeout(timer);
                this.connected = true;
                this.reconnectAttempts = 0;
                this.reconnectDelay = 1000;
                this.lastPingTime = Date.now();

                // Send queued messages
                while (this.queue.length) {
                    this.ws.send(this.queue.shift());
                }
                
                // Start auto-ping if enabled
                if (this.autoPing) {
                    this.startPing();
                }
                
                resolve();
                console.log(`✅ Connected to ${this.url}`);
            };

            this.ws.onclose = (event) => {
                this.handleConnectionClose(event);
            };

            this.ws.onerror = (err) => {
                clearTimeout(timer);
                this.handleConnectionError(err);
                reject(new Error(`GrapheneRPC: WebSocket error: ${err.message || err}`));
            };

            this.ws.onmessage = (event) => {
                try {
                    const response = JSON.parse(event.data);
                    // Handle ping responses specially
                    if (response.method === "ping") {
                        this.pingLatency = Date.now() - this.lastPingTime;
                        return;
                    }
                    // Standard message handling will be done by individual queries
                } catch (e) {
                    console.error('Error parsing message:', e);
                }
            };
        });

        return this.connectionPromise;
    }

    /**
     * Start automatic ping every 30 seconds
     */
    startPing() {
        this.stopPing();
        
        this.pingInterval = setInterval(async () => {
            if (!this.connected || this.ws.readyState !== WebSocket.OPEN) {
                this.stopPing();
                return;
            }

            try {
                // Record ping start time
                this.lastPingTime = Date.now();
                
                // Ping with get_objects for dynamic global properties (2.8.0)
                await this.getObjects(["2.8.0"]);
                
                // Update latency
                this.pingLatency = Date.now() - this.lastPingTime;
                console.log(`🏓 Ping successful to ${this.url} - Latency: ${this.pingLatency}ms`);
                
            } catch (error) {
                console.error(`❌ Ping failed to ${this.url}:`, error.message);
                this.handleConnectionError(error);
            }
        }, 30000);
    }

    /**
     * Stop automatic ping
     */
    stopPing() {
        if (this.pingInterval) {
            clearInterval(this.pingInterval);
            this.pingInterval = null;
        }
    }

    /**
     * Handle connection close events
     * @param {CloseEvent} event
     */
    handleConnectionClose(event) {
        this.connected = false;
        this.stopPing();
        
        console.log(`🔌 Connection closed to ${this.url}: code ${event.code}, reason: ${event.reason}`);
        
        // Attempt to reconnect if this was unexpected
        if (event.code !== 1000) { // 1000 = normal closure
            this.attemptReconnect();
        }
    }

    /**
     * Handle connection error events
     * @param {Error} error
     */
    handleConnectionError(error) {
        this.connected = false;
        this.stopPing();
        
        console.error(`❌ Connection error to ${this.url}:`, error.message);
        this.attemptReconnect();
    }

    /**
     * Attempt to reconnect with exponential backoff
     */
    attemptReconnect() {
        if (this.reconnectAttempts >= this.maxReconnectAttempts) {
            console.error(`🚫 Max reconnect attempts reached for ${this.url}`);
            return;
        }

        this.reconnectAttempts++;
        const delay = this.reconnectDelay * this.reconnectAttempts;
        
        console.log(`🔄 Attempting reconnect ${this.reconnectAttempts}/${this.maxReconnectAttempts} to ${this.url} in ${delay}ms`);
        
        setTimeout(() => {
            this.connectionPromise = null;
            this.connect().catch(() => {
                // If reconnect fails, it will attempt again automatically
            });
        }, delay);
    }

    /**
     * Close the connection permanently
     */
    close() {
        this.stopPing();
        if (this.ws) {
            this.ws.close();
        }
        this.connected = false;
    }

    query(api, params) {
        return new Promise((resolve, reject) => {
            if (!this.connected || this.ws.readyState !== WebSocket.OPEN) {
                reject(new Error("Not connected to node"));
                return;
            }

            const requestId = this.requestId++;
            const payload = JSON.stringify({
                method: "call",
                params: [api, ...params],
                jsonrpc: "2.0",
                id: requestId,
            });

            const listener = (event) => {
                try {
                    const response = JSON.parse(event.data);
                    if (response.id === requestId) {
                        this.ws.removeEventListener("message", listener);
                        if ("result" in response) {
                            resolve(response.result);
                        } else {
                            reject(response.error || new Error("RPC call failed"));
                        }
                    }
                } catch (parseError) {
                    console.error('Error parsing response:', parseError);
                    reject(parseError);
                }
            };

            this.ws.addEventListener("message", listener);

            // Set timeout for this specific request
            const timeoutId = setTimeout(() => {
                this.ws.removeEventListener("message", listener);
                reject(new Error("Request timeout"));
            }, this.timeout);

            this.ws.send(payload);

            // Clean up timeout when request completes
            const cleanup = () => {
                clearTimeout(timeoutId);
                this.ws.removeEventListener("message", listener);
            };

            // We can't directly hook into the promise resolution here, so we'll rely on the listener cleanup
        });
    }

    precision(number, places) {
        return parseFloat(number).toFixed(places);
    }

    /**
     * Return data about objects in 1.7.x, 2.4.x, 1.3.x, etc. format.
     */

    /**
     * Batch get_objects with automatic chunking for >90 ids
     * @param {string[]} objectIds 
     * @returns {Promise<Object>} map of objectId -> object
     */
    async getObjects(objectIds) {
        const results = [];
        const resultMap = {};

        for (let i = 0; i < objectIds.length; i += 90) {
            const chunk = objectIds.slice(i, i + 90);
            try {
                const chunkResult = await this.query("database", ["get_objects", [chunk]]);
                chunk.forEach((id, idx) => {
                    if (idx < chunkResult.length && chunkResult[idx] !== null) {
                        resultMap[id] = chunkResult[idx];
                        results.push(chunkResult[idx]);
                    }
                });
            } catch (error) {
                console.error(`Error fetching objects chunk:`, error);
                // Continue with other chunks
            }
        }

        return resultMap;
    }
    async getObjectsByName(objectNames) {
        const results = [];
        const resultMap = {};

        for (let i = 0; i < objectNames.length; i += 90) {
            const chunk = objectNames.slice(i, i + 90);
            try {
                const chunkResult = await this.query("database", ["lookup_asset_symbols", [chunk]]);
                chunk.forEach((id, idx) => {
                    if (idx < chunkResult.length && chunkResult[idx] !== null) {
                        resultMap[id] = chunkResult[idx];
                        results.push(chunkResult[idx]);
                    }
                });
            } catch (error) {
                console.error(`Error fetching objects chunk:`, error);
                // Continue with other chunks
            }
        }

        return resultMap;
    }


    /**
     * Fetches account balances for specified asset IDs.
     * Uses: cache.account_name
     */
    async rpcAccountBalances(cache, assetIds, assetPrecisions) {
        if (!assetIds.includes("1.3.0")) {
            assetIds.push("1.3.0");
            assetPrecisions.push(5);
        }
        const ret = await this.query("database", ["get_named_account_balances", [cache.account_name, assetIds]]);
        const balances = Object.fromEntries(assetIds.map(id => [id, 0]));
        for (let i = 0; i < assetIds.length; i++) {
            for (const balance of ret) {
                if (balance.asset_id === assetIds[i]) {
                    balances[assetIds[i]] += parseFloat(balance.amount) / Math.pow(10, assetPrecisions[i]);
                }
            }
        }
        return balances;
    }

    /**
     * Retrieves recent trade history between 'now' and 'then'.
     * Uses: cache.currency, cache.asset, cache.asset_precision
     */
    async rpcMarketHistory(cache, now, then, depth = 100) {
        const tradeHistory = await this.query("database", ["get_trade_history", [cache.currency, cache.asset, now, then, depth]]);
        const history = tradeHistory.map(value => {
            const unix = Math.floor(new Date(value.date).getTime() / 1000);
            const price = this.precision(value.price, 16);
            if (parseFloat(price) === 0) throw new Error("zero price in history");
            const amount = this.precision(value.amount, cache.asset_precision);
            return [unix, price, amount];
        });
        if (history.length === 0) throw new Error("no history");
        return history;
    }

    /**
     * Looks up asset symbols and precisions.
     * Uses: cache.asset, cache.currency
     */
    async rpcLookupAssetSymbols(cache) {
        const ret = await this.query("database", ["lookup_asset_symbols", [
            [cache.asset, cache.currency]
        ]]);
        return [ret[0].id, ret[0].precision, ret[1].id, ret[1].precision];
    }

    /**
     * Checks recent blocks' timestamp to compute latency.
     * Uses: storage.mean_ping
     */
    async rpcBlockLatency(storage) {
        const dgp = await this.query("database", ["get_dynamic_global_properties", []]);
        const blocktime = new Date(dgp.time).getTime() / 1000;
        const latency = Math.min(9.999, (Date.now() / 1000) - blocktime);
        const max = Math.min(9.999, 3 + 3 * storage.mean_ping);
        if (latency > max) throw new Error("stale blocktime", latency);
        return [latency, max, Math.floor(blocktime)];
    }

    /**
     * Looks up account info by name.
     * Uses: cache.account_name
     */
    async rpcLookupAccounts(cache) {
        const ret = await this.query("database", ["lookup_accounts", [cache.account_name, 1]]);
        return ret[0][1];
    }

    /**
     * Pings chain and checks response time and ID.
     * Uses: storage.mean_ping
     */
    async rpcPingLatency(storage, expectedChainId) {
        const start = Date.now() / 1000;
        const chainId = await this.query("database", ["get_chain_id", []]);
        const latency = Math.min(9.999, (Date.now() / 1000) - start);
        const max = Math.min(2, 2 * storage.mean_ping);
        if (chainId !== expectedChainId) throw new Error("chain_id != ID");
        if (latency > max) throw new Error("slow ping", latency);
        return [latency, max];
    }

    /**
     * Retrieves current order book data up to specified depth.
     * Uses: cache.currency, cache.asset, cache.asset_precision
     */
    async rpcBook(cache, depth = 3) {
        const orderBook = await this.query("database", ["get_order_book", [cache.currency, cache.asset, depth]]);
        const askp = [],
            bidp = [],
            askv = [],
            bidv = [];
        for (const ask of orderBook.asks) {
            const price = this.precision(ask.price, 16);
            if (parseFloat(price) === 0) throw new Error("zero price in asks");
            const volume = this.precision(ask.quote, cache.asset_precision);
            askp.push(price);
            askv.push(volume);
        }
        for (const bid of orderBook.bids) {
            const price = this.precision(bid.price, 16);
            if (parseFloat(price) === 0) throw new Error("zero price in bids");
            const volume = this.precision(bid.quote, cache.asset_precision);
            bidp.push(price);
            bidv.push(volume);
        }
        if (parseFloat(bidp[0]) >= parseFloat(askp[0])) throw new Error("mismatched orderbook");
        return [askp, bidp, askv, bidv];
    }

    /**
     * Retrieves and processes open limit orders.
     * Uses: cache.account_name, cache.currency_id, cache.asset_id, 
     *       cache.currency_precision, cache.asset_precision, cache.pair
     */
    async rpcOpenOrders(cache) {
        const ret = await this.query("database", ["get_full_accounts", [
            [cache.account_name], false
        ]]);
        const limitOrders = (ret[0][1] && ret[0][1].limit_orders) || [];
        const orders = [];

        for (const order of limitOrders) {
            const baseId = order.sell_price.base.asset_id;
            const quoteId = order.sell_price.quote.asset_id;
            if ([cache.currency_id, cache.asset_id].includes(baseId) && [cache.currency_id, cache.asset_id].includes(quoteId)) {
                let amount = parseFloat(order.for_sale);
                let baseAmount = parseFloat(order.sell_price.base.amount);
                let quoteAmount = parseFloat(order.sell_price.quote.amount);

                const basePrecision = baseId === cache.currency_id ? cache.currency_precision : cache.asset_precision;
                const quotePrecision = baseId === cache.currency_id ? cache.asset_precision : cache.currency_precision;

                baseAmount /= Math.pow(10, basePrecision);
                quoteAmount /= Math.pow(10, quotePrecision);

                let orderType, price;
                if (baseId === cache.asset_id) {
                    orderType = "sell";
                    price = quoteAmount / baseAmount;
                    amount = amount / Math.pow(10, basePrecision);
                } else {
                    orderType = "buy";
                    price = baseAmount / quoteAmount;
                    amount = (amount / Math.pow(10, basePrecision)) / price;
                }

                orders.push({
                    orderNumber: order.id,
                    orderType,
                    market: cache.pair,
                    amount: this.precision(amount, cache.asset_precision),
                    price: this.precision(price, 16),
                });
            }
        }
        return orders.sort((a, b) => parseFloat(a.price) - parseFloat(b.price));
    }

    /**
     * Retrieves the latest market price.
     * Uses: cache.currency, cache.asset
     */
    async rpcLast(cache) {
        const ticker = await this.query("database", ["get_ticker", [cache.currency, cache.asset, false]]);
        const last = this.precision(ticker.latest, 16);
        if (parseFloat(last) === 0) throw new Error("zero price last");
        return last;
    }
}


/*
 * Manages a single GrapheneRPC connection with automatic failover to other nodes
 * - Connects to only one node at a time
 * - Automatically switches to next node if current one fails
 * - Has built-in node list with automatic failover
 * - Maintains connection health through regular pinging
 */
class GrapheneRPCPool {
    /**
     * @param {Object} [options] - Configuration options
     * @param {string[]} [options.nodes] - Array of node URLs to use
     * @param {number} [options.maxRetries=3] - Maximum number of retries per method call
     * @param {number} [options.timeoutMs=3000] - Timeout per individual request in milliseconds
     * @param {number} [options.failoverDelay=1000] - Delay between failover attempts in ms
     */
    constructor(options = {}) {
        const defaultNodes = [
            "wss://api.bitshares.dev/wss",
            "wss://newyork.bitshares.im/wss",
            "wss://api.bts.mobi/wss",
            "wss://eu.nodes.bitshares.ws/wss",
            "wss://asia.nodes.bitshares.ws/wss",
            "wss://api.dex.trading",
            "wss://bts.open.icowallet.net/ws",
            "wss://dex.iobanker.com/wss"
        ];

        this.nodes = options.nodes || defaultNodes;
        this.maxRetries = options.maxRetries || 3;
        this.timeoutMs = options.timeoutMs || 3000;
        this.failoverDelay = options.failoverDelay || 1000;
        this.currentNodeIndex = 0;
        this.activeInstance = null;
        this.chainId = null;
        this.meanPing = 0.1; // Default mean ping for latency checks
        this.nodeHealth = new Map(); // Map<nodeUrl, { lastAttempted, errorCount, lastSuccess }>

        // Initialize node health tracking
        this.nodes.forEach(url => {
            this.nodeHealth.set(url, {
                lastAttempted: 0,
                errorCount: 0,
                lastSuccess: 0,
                latency: Infinity
            });
        });

        // Set up proxy to handle method calls
        return new Proxy(this, {
            get: (target, prop, receiver) => {
                if (typeof target[prop] !== "undefined") return Reflect.get(target, prop, receiver);

                // Create a wrapper for instance method calls
                return async(...args) => {
                    return await target._callWithFailover(prop, args);
                };
            }
        });
    }

    /**
     * Get or create the active RPC instance
     * @returns {GrapheneRPC} Active RPC instance
     */
    async getActiveInstance() {
        if (this.activeInstance && this.activeInstance.connected) {
            return this.activeInstance;
        }

        // Try to connect to a healthy node
        return this.connectToNextNode();
    }

    /**
     * Connect to the next available node in the list
     * @returns {Promise<GrapheneRPC>} Connected RPC instance
     */
    async connectToNextNode() {
        if (this.activeInstance) {
            this.activeInstance.close();
            this.activeInstance = null;
        }

        const maxAttempts = this.nodes.length;
        let attempts = 0;
        let lastError;

        while (attempts < maxAttempts) {
            const nodeUrl = this.nodes[this.currentNodeIndex];
            const health = this.nodeHealth.get(nodeUrl);
            
            console.log(`🔄 Attempting to connect to node ${this.currentNodeIndex + 1}/${this.nodes.length}: ${nodeUrl}`);
            
            try {
                // Update last attempted time
                this.nodeHealth.set(nodeUrl, {
                    ...health,
                    lastAttempted: Date.now()
                });

                // Create new instance and wait for connection
                this.activeInstance = new GrapheneRPC(nodeUrl, 10000, true);
                
                // Wait for connection to establish
                await this.activeInstance.connectionPromise;
                
                // Connection successful - reset error count
                this.nodeHealth.set(nodeUrl, {
                    ...health,
                    errorCount: 0,
                    lastSuccess: Date.now(),
                    latency: this.activeInstance.pingLatency
                });
                
                console.log(`✅ Successfully connected to ${nodeUrl}`);
                return this.activeInstance;
                
            } catch (error) {
                lastError = error;
                console.error(`❌ Failed to connect to ${nodeUrl}:`, error.message);
                
                // Update error count
                this.nodeHealth.set(nodeUrl, {
                    ...health,
                    errorCount: (health.errorCount || 0) + 1
                });
                
                // Move to next node
                this.currentNodeIndex = (this.currentNodeIndex + 1) % this.nodes.length;
                attempts++;
                
                // Wait before trying next node
                if (attempts < maxAttempts) {
                    await new Promise(resolve => setTimeout(resolve, this.failoverDelay));
                }
            }
        }

        // All nodes failed
        this.activeInstance = null;
        throw new Error(`Failed to connect to any node after ${maxAttempts} attempts. Last error: ${lastError?.message}`);
    }

    /**
     * Internal method to call a method with failover capability
     * @param {string} method - Method name to call
     * @param {Array} args - Arguments to pass to the method
     */
    async _callWithFailover(method, args) {
        let lastError;
        let retryCount = 0;

        while (retryCount < this.maxRetries) {
            try {
                const instance = await this.getActiveInstance();
                
                if (!instance || !instance.connected) {
                    throw new Error('No active connection available');
                }

                // Execute the method with timeout
                const result = await Promise.race([
                    instance[method](...args),
                    new Promise((_, reject) => 
                        setTimeout(() => reject(new Error("RPC call timeout")), this.timeoutMs)
                    )
                ]);
                
                // Mark this node as healthy
                const url = instance.url;
                const health = this.nodeHealth.get(url) || {};
                this.nodeHealth.set(url, {
                    ...health,
                    errorCount: 0,
                    lastSuccess: Date.now()
                });
                
                return result;
                
            } catch (err) {
                lastError = err;
                retryCount++;
                console.error(`❌ Call failed on attempt ${retryCount}:`, err.message);
                
                // If connection is lost or node is unresponsive, try next node
                if (err.message.includes('Not connected') || 
                    err.message.includes('timeout') || 
                    err.message.includes('Connection closed') ||
                    err.message.includes('WebSocket error')) {
                    
                    console.log(`🔄 Connection issue detected, switching to next node...`);
                    await this.connectToNextNode();
                }
                
                // Wait before retrying
                if (retryCount < this.maxRetries) {
                    await new Promise(resolve => setTimeout(resolve, this.failoverDelay * retryCount));
                }
            }
        }

        throw new Error(`RPC call failed after ${this.maxRetries} retries: ${lastError?.message}`);
    }

    /**
     * Close the current connection
     */
    close() {
        if (this.activeInstance) {
            this.activeInstance.close();
            this.activeInstance = null;
        }
        console.log('👋 Connection closed');
    }

    /**
     * Get current node status
     * @returns {Object} Status information about the current node
     */
    getNodeStatus() {
        if (!this.activeInstance) {
            return {
                connected: false,
                currentNode: this.currentNodeIndex,
                currentNodeUrl: this.nodes[this.currentNodeIndex],
                health: this.nodeHealth.get(this.nodes[this.currentNodeIndex]) || {}
            };
        }

        const url = this.activeInstance.url;
        const health = this.nodeHealth.get(url) || {};
        return {
            connected: this.activeInstance.connected,
            currentNode: this.currentNodeIndex,
            currentNodeUrl: url,
            health: {
                ...health,
                pingLatency: this.activeInstance.pingLatency,
                reconnectAttempts: this.activeInstance.reconnectAttempts
            }
        };
    }

    /**
     * Force switch to the next node
     */
    async switchToNextNode() {
        this.currentNodeIndex = (this.currentNodeIndex + 1) % this.nodes.length;
        return this.connectToNextNode();
    }
}

// Export for use in browsers
if (typeof window !== 'undefined') {
    window.GrapheneRPC = GrapheneRPC;
    window.GrapheneRPCPool = GrapheneRPCPool;
}
