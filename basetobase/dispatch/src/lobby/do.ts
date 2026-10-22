import { DurableObject } from "cloudflare:workers";
import type { LobbyMessage, RunSummary } from "../../../shared/src/types.ts";

// One lobby for every open runs list. It keeps nothing: it passes each summary it is handed to the
// sockets open at the time, using hibernation so idle viewers cost nothing.
export class LobbyDO extends DurableObject<Env> {
  async fetch(req: Request): Promise<Response> {
    if (req.headers.get("Upgrade") !== "websocket") {
      return new Response("expected a websocket upgrade", { status: 426 });
    }
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  summary(run: RunSummary): void {
    const sockets = this.ctx.getWebSockets();
    if (sockets.length === 0) return;
    const message: LobbyMessage = { type: "summary", run };
    const payload = JSON.stringify(message);
    for (const socket of sockets) {
      try {
        socket.send(payload);
      } catch {
        // A viewer whose socket is closing must not keep the others from hearing.
      }
    }
  }

  // Viewers only listen: whatever one sends is dropped.
  webSocketMessage(): void {}
}

export function lobbyStub(env: Env): DurableObjectStub<LobbyDO> {
  return env.LOBBY.get(env.LOBBY.idFromName("lobby"));
}

// Never throws: a lobby that is down must not fail the run that reported. False when the lobby
// did not hear it, so the caller can send it again.
export async function announce(env: Env, run: RunSummary): Promise<boolean> {
  try {
    await lobbyStub(env).summary(run);
    return true;
  } catch (error) {
    console.error(`lobby notify failed: ${error instanceof Error ? error.message : error}`);
    return false;
  }
}
