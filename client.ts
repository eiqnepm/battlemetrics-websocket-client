import { v1 as uuid } from "uuid";
import { EventEmitter } from "events";
import WebSocket from "ws";

interface IRTMessage {
  i: string;
  t: string;
  c?: string;
  p: any;
}

type TMessageSource =
  | "trigger"
  | "banProcessor"
  | "scheduler"
  | "user"
  | "server"
  | "player"
  | "reservedSlotProcessor";

// Message format
export interface IAPIActivityMessage {
  type: "activityMessage";
  id: string;
  attributes: {
    messageType: string;
    timestamp: string;
    source: TMessageSource;
    message: string;
    categories: string[];
    tags: Array<{
      id: string;
      tag: string;
      userId: string;
      color: string;
    }>;
    data: {
      [key: string]: any;
    };
  };
  relationships: {
    organizations: {
      data: Array<{
        type: "organization";
        id: string;
      }>;
    };
    servers?: {
      data: Array<{
        type: "server";
        id: string;
      }>;
    };
    users?: {
      data: Array<{
        type: "user";
        id: string;
      }>;
    };
    bans?: {
      data: Array<{
        type: "ban";
        id: string;
      }>;
    };
    players?: {
      data: Array<{
        type: "player";
        id: string;
      }>;
    };
    sessions?: {
      data: Array<{
        type: "session";
        id: string;
      }>;
    };
    triggers?: {
      data: Array<{
        type: "trigger";
        id: string;
      }>;
    };
    schedules?: {
      data: Array<{
        type: "schedule";
        id: string;
      }>;
    };
    games?: {
      data: Array<{
        type: "game";
        id: string;
      }>;
    };
  };
}

export class WSClient extends EventEmitter {
  private ws: WebSocket | undefined;
  private lastPing: number | undefined;
  private monitorInterval: NodeJS.Timer | undefined;
  private reconnectTimeout: NodeJS.Timer | undefined;
  private lastMessage: string | undefined;
  private lastConnected: number | undefined;
  private channels: Set<string> = new Set();
  private filters: Map<string, any> = new Map();
  private retryDelay: number = 0;
  private replayMaxTime: number;
  private getAccessToken: () => Promise<string | undefined>;

  constructor(
    getAccessToken: () => Promise<string | undefined>,
    replayMaxTime: number
  ) {
    super();
    this.replayMaxTime = replayMaxTime;
    this.getAccessToken = getAccessToken;
  }

  join(channel: string) {
    if (this.channels.has(channel)) return;
    this.channels.add(channel);

    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(
        JSON.stringify({
          i: uuid(),
          t: "join",
          p: [channel],
        })
      );
    }
  }

  leave(channel: string) {
    this.channels.delete(channel);

    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(
        JSON.stringify({
          i: uuid(),
          t: "leave",
          p: [channel],
        })
      );
    }
  }

  filter(type: string, filter: any): void {
    if (this.filters.get(type) === filter) return;
    this.filters.set(type, filter);

    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(
        JSON.stringify({
          i: uuid(),
          t: "filter",
          p: {
            type,
            filter,
          },
        })
      );
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

  private onOpen = async () => {
    const prevLastConnected = this.lastConnected;
    this.lastConnected = Date.now();

    this.lastPing = Date.now();
    this.retryDelay = 0;
    this.monitorConnection();

    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      const token = await this.getAccessToken();

      // Will be called after auth if we have a token.
      const joinRoomsFilter = () => {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
          this.filters.forEach((filter, type) => {
            this.ws!.send(
              JSON.stringify({
                i: uuid(),
                t: "filter",
                p: {
                  type,
                  filter,
                },
              })
            );
          });

          this.ws.send(
            JSON.stringify({
              i: uuid(),
              t: "join",
              p: Array.from(this.channels),
            })
          );

          if (
            this.lastMessage &&
            prevLastConnected &&
            Date.now() - prevLastConnected < this.replayMaxTime
          ) {
            console.log("Will replay");
            this.ws.send(
              JSON.stringify({
                i: uuid(),
                t: "replay",
                p: {
                  channels: Array.from(this.channels),
                  start: this.lastMessage,
                },
              })
            );
          } else {
            const lastMessage = prevLastConnected
              ? `${Date.now() - prevLastConnected}ms ago`
              : "never";

            console.log(
              `No replay. Last message was too long ago, or no message to replay from. Last connected: ${lastMessage}`
            );
          }
        }
      };

      if (token) {
        const authId = uuid();

        this.ws.send(
          JSON.stringify({
            i: authId,
            t: "auth",
            p: token,
          })
        );

        const onMsg = (e: { data: any }) => {
          const msg = JSON.parse(e.data) as IRTMessage;
          if (msg.i === authId) {
            if (this.ws) {
              this.ws.removeEventListener("message", onMsg);
            }

            joinRoomsFilter();
          }
        };

        this.ws.addEventListener("message", onMsg);
      } else {
        joinRoomsFilter();
      }
    }
  };

  private onClose = () => {
    this.ws = undefined;
    if (this.monitorInterval) {
      clearInterval(this.monitorInterval);
      this.monitorInterval = undefined;
    }

    this.retryConnection();
  };

  private onMessage = (e: { data: any }) => {
    this.lastPing = Date.now();

    if (typeof e.data === "string") {
      const msg = JSON.parse(e.data) as IRTMessage;
      if (msg.i && msg.t !== "error" && msg.t !== "ack") {
        this.lastMessage = msg.i;
      }

      if (msg.t === "ack") return;
      this.emit("message", msg);
    }
  };

  private setupConnection() {
    const ws = (this.ws = new WebSocket("wss://ws.battlemetrics.com"));

    ws.addEventListener("open", this.onOpen);
    ws.addEventListener("close", this.onClose);
    ws.addEventListener("message", this.onMessage);
    ws.addEventListener("error", this.retryConnection);
  }

  private retryConnection = () => {
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
    }

    this.reconnectTimeout = setTimeout(() => {
      this.reconnectTimeout = undefined;
      this.setupConnection();
    }, this.retryDelay * 1000);

    this.retryDelay = Math.min(
      60,
      this.retryDelay + (Math.floor(Math.random() * 6) + 5)
    );
  };

  private monitorConnection() {
    if (this.monitorInterval) clearTimeout(this.monitorInterval);

    this.monitorInterval = setTimeout(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(
          JSON.stringify({
            i: uuid(),
            t: "ping",
          })
        );
      }

      if (this.lastPing && this.lastPing < Date.now() - 60000) {
        // tslint:disable-next-line no-console
        console.log(
          "Last activity more than a minute ago. Closing connection."
        );

        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
          this.close();
          this.open();
        }
      }

      this.monitorConnection();
    }, 30000);
  }
}
