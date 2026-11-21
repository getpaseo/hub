import {
  SimpleContextFetchingStrategy,
  WebSocketShard,
  WebSocketShardEvents,
  managerToFetchingStrategyOptions,
  type IShardingStrategy,
  type WebSocketManager,
  type WebSocketShardDestroyOptions,
  type WebSocketShardEventsMap,
} from "@discordjs/ws";
import { Collection } from "@discordjs/collection";
import { WebSocket } from "ws";

/** The SDK's default in-process strategy with cancellation at the shard boundary. */
export function createDiscordGatewayStrategy(
  manager: WebSocketManager,
  startup: AbortSignal,
): IShardingStrategy {
  const shards = new Collection<number, WebSocketShard>();
  startup.addEventListener(
    "abort",
    () => {
      const reason: unknown = startup.reason;
      const error =
        reason instanceof Error ? reason : new Error("Discord gateway startup cancelled");
      for (const shard of shards.values()) {
        // Normal SDK destruction leaves its READY wait pending and can already be in
        // progress inside Client.login(). Cancel the transport independently of it.
        terminateShardSocket(shard);
        shard.emit(WebSocketShardEvents.Error, { error });
      }
    },
    { once: true },
  );

  return {
    async spawn(ids) {
      startup.throwIfAborted();
      const options = await managerToFetchingStrategyOptions(manager);
      startup.throwIfAborted();
      const context = new StartupShardContext(manager, options, startup);
      for (const id of ids) {
        const shard = new StartupShard(context, id, startup);
        for (const event of Object.values(WebSocketShardEvents)) {
          shard.on(event, (payload: WebSocketShardEventsMap[typeof event][0]) =>
            manager.emit(event, { ...payload, shardId: id }),
          );
        }
        shards.set(id, shard);
      }
    },
    async connect() {
      startup.throwIfAborted();
      await Promise.all(shards.map((shard) => shard.connect()));
    },
    async destroy(options) {
      await Promise.all(shards.map((shard) => shard.destroy(options)));
      shards.clear();
    },
    fetchStatus: () => shards.mapValues((shard) => shard.status),
    async send(id, payload) {
      const shard = shards.get(id);
      if (shard === undefined) throw new RangeError(`No Discord gateway shard ${id}`);
      await shard.send(payload);
    },
  };
}

class StartupShardContext extends SimpleContextFetchingStrategy {
  constructor(
    manager: WebSocketManager,
    options: ConstructorParameters<typeof SimpleContextFetchingStrategy>[1],
    private readonly startup: AbortSignal,
  ) {
    super(manager, options);
  }

  override async retrieveSessionInfo(id: number) {
    const session = await super.retrieveSessionInfo(id);
    if (this.startup.aborted) {
      // A recovery already in backoff can still reach this point after destruction.
      // The SDK calls internalConnect without a rejection handler, so park it before socket creation.
      return new Promise<never>(() => {});
    }
    return session;
  }
}

class StartupShard extends WebSocketShard {
  constructor(
    context: StartupShardContext,
    id: number,
    private readonly startup: AbortSignal,
  ) {
    super(context, id);
  }

  override async destroy(options?: WebSocketShardDestroyOptions) {
    // Aborting Hello/READY inside SDK destroy otherwise schedules another connection.
    if (this.startup.aborted && options?.recover !== undefined) return;
    await super.destroy(options);
  }
}

function terminateShardSocket(shard: WebSocketShard) {
  // @discordjs/ws 1.2.3 only closes OPEN sockets. Its Node transport also needs to
  // cancel pending upgrades, and terminate avoids waiting for a peer's close frame.
  const socket: unknown = Reflect.get(shard, "connection");
  if (socket instanceof WebSocket) {
    socket.once("error", () => {}); // ws emits an error when an upgrade is terminated.
    socket.terminate();
  }
}
