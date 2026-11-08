// What the trusted viewer shares with the bridge: the message protocol and the checks that
// accept a message. The bridge itself ships as a separate bundle (`@portifact/bridge/bundle`).
export * from "./channel.ts";
export * from "./protocol.ts";
