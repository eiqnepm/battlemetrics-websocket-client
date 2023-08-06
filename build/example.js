"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const client_1 = require("./client");
const conn = new client_1.WSClient(() => {
    // Fetch your API key here, or hard code it and return it. We're passing
    // undefined and will only receive public data.
    // With an API key use something like Promise.resolve("my api key");
    return Promise.resolve(undefined);
}, 5 * 60 * 1000);
conn.open();
const serverId = process.argv[2];
console.log("serverId", serverId);
// Player join, leave, query. Public data.
conn.join(`server:events:${serverId}`);
// All player join/leave/update and server update info. Will receive private
// data when authenticated/authorized.
conn.join(`server:updates:${serverId}`);
// Everything that can show in server activity feed
conn.join(`server:activity:${serverId}`);
const filter = {
    tagTypeMode: "and",
    tags: {},
    types: {
        whitelist: ["playerMessage"],
    },
};
// Filter down to only playerMessages
conn.filter("ACTIVITY", filter);
conn.on("message", (msg) => {
    console.log("msg", msg);
});
