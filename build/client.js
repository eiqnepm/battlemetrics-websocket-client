"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const lodash_1 = __importDefault(require("lodash"));
const v1_1 = __importDefault(require("uuid/v1"));
const events_1 = require("events");
const ws_1 = __importDefault(require("ws"));
class WSClient extends events_1.EventEmitter {
    constructor(getAccessToken, replayMaxTime) {
        super();
        this.channels = new Set();
        this.filters = new Map();
        this.retryDelay = 0;
        this.onOpen = async () => {
            const prevLastConnected = this.lastConnected;
            this.lastConnected = Date.now();
            this.lastPing = Date.now();
            this.retryDelay = 0;
            this.monitorConnection();
            if (this.ws && this.ws.readyState === ws_1.default.OPEN) {
                const token = await this.getAccessToken();
                // Will be called after auth if we have a token.
                const joinRoomsFilter = () => {
                    if (this.ws && this.ws.readyState === ws_1.default.OPEN) {
                        this.filters.forEach((filter, type) => {
                            this.ws.send(JSON.stringify({
                                i: v1_1.default(),
                                t: "filter",
                                p: {
                                    type,
                                    filter
                                }
                            }));
                        });
                        this.ws.send(JSON.stringify({
                            i: v1_1.default(),
                            t: "join",
                            p: Array.from(this.channels)
                        }));
                        if (this.lastMessage &&
                            prevLastConnected &&
                            Date.now() - prevLastConnected < this.replayMaxTime) {
                            console.log("Will replay");
                            this.ws.send(JSON.stringify({
                                i: v1_1.default(),
                                t: "replay",
                                p: {
                                    channels: Array.from(this.channels),
                                    start: this.lastMessage
                                }
                            }));
                        }
                        else {
                            const lastMessage = prevLastConnected
                                ? `${Date.now() - prevLastConnected}ms ago`
                                : "never";
                            console.log(`No replay. Last message was too long ago, or no message to replay from. Last connected: ${lastMessage}`);
                        }
                    }
                };
                if (token) {
                    const authId = v1_1.default();
                    this.ws.send(JSON.stringify({
                        i: authId,
                        t: "auth",
                        p: token
                    }));
                    const onMsg = (e) => {
                        const msg = JSON.parse(e.data);
                        if (msg.i === authId) {
                            if (this.ws) {
                                this.ws.removeEventListener("message", onMsg);
                            }
                            joinRoomsFilter();
                        }
                    };
                    this.ws.addEventListener("message", onMsg);
                }
                else {
                    joinRoomsFilter();
                }
            }
        };
        this.onClose = () => {
            this.ws = undefined;
            if (this.monitorInterval) {
                clearInterval(this.monitorInterval);
                this.monitorInterval = undefined;
            }
            this.retryConnection();
        };
        this.onMessage = (e) => {
            this.lastPing = Date.now();
            if (lodash_1.default.isString(e.data)) {
                const msg = JSON.parse(e.data);
                if (msg.i && msg.t !== "error" && msg.t !== "ack") {
                    this.lastMessage = msg.i;
                }
                if (msg.t === "ack")
                    return;
                this.emit("message", msg);
            }
        };
        this.retryConnection = () => {
            if (this.reconnectTimeout) {
                clearTimeout(this.reconnectTimeout);
            }
            this.reconnectTimeout = setTimeout(() => {
                this.reconnectTimeout = undefined;
                this.setupConnection();
            }, this.retryDelay * 1000);
            this.retryDelay = Math.min(60, this.retryDelay + lodash_1.default.random(5, 10));
        };
        this.replayMaxTime = replayMaxTime;
        this.getAccessToken = getAccessToken;
    }
    join(channel) {
        if (this.channels.has(channel))
            return;
        this.channels.add(channel);
        if (this.ws && this.ws.readyState === ws_1.default.OPEN) {
            this.ws.send(JSON.stringify({
                i: v1_1.default(),
                t: "join",
                p: [channel]
            }));
        }
    }
    leave(channel) {
        this.channels.delete(channel);
        if (this.ws && this.ws.readyState === ws_1.default.OPEN) {
            this.ws.send(JSON.stringify({
                i: v1_1.default(),
                t: "leave",
                p: [channel]
            }));
        }
    }
    filter(type, filter) {
        if (this.filters.get(type) === filter)
            return;
        this.filters.set(type, filter);
        if (this.ws && this.ws.readyState === ws_1.default.OPEN) {
            this.ws.send(JSON.stringify({
                i: v1_1.default(),
                t: "filter",
                p: {
                    type,
                    filter
                }
            }));
        }
    }
    close() {
        if (this.ws) {
            this.ws.removeEventListener("close", this.onClose);
            this.ws.removeEventListener("open", this.onOpen);
            this.ws.removeEventListener("message", this.onMessage);
            this.ws.removeEventListener("error", this.retryConnection);
            // Close causes an error
            this.ws.close();
            this.ws = undefined;
            if (this.reconnectTimeout) {
                clearTimeout(this.reconnectTimeout);
                this.reconnectTimeout = undefined;
            }
        }
    }
    open() {
        if (!this.ws) {
            this.setupConnection();
            if (this.reconnectTimeout) {
                clearTimeout(this.reconnectTimeout);
                this.reconnectTimeout = undefined;
            }
        }
    }
    setupConnection() {
        const ws = (this.ws = new ws_1.default("wss://ws.battlemetrics.com"));
        ws.addEventListener("open", this.onOpen);
        ws.addEventListener("close", this.onClose);
        ws.addEventListener("message", this.onMessage);
        ws.addEventListener("error", this.retryConnection);
    }
    monitorConnection() {
        if (this.monitorInterval)
            clearTimeout(this.monitorInterval);
        this.monitorInterval = setTimeout(() => {
            if (this.ws && this.ws.readyState === ws_1.default.OPEN) {
                this.ws.send(JSON.stringify({
                    i: v1_1.default(),
                    t: "ping"
                }));
            }
            if (this.lastPing && this.lastPing < Date.now() - 60000) {
                // tslint:disable-next-line no-console
                console.log("Last activity more than a minute ago. Closing connection.");
                if (this.ws && this.ws.readyState === ws_1.default.OPEN) {
                    this.close();
                    this.open();
                }
            }
            this.monitorConnection();
        }, 30000);
    }
}
exports.WSClient = WSClient;
