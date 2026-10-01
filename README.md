# trellis

A framework for roblox-ts games. You split the server into services and the client into
controllers, and they talk through typed contracts. Every call a client makes is checked and
rate limited before your code sees it, and every error a player hits gets a short code you can
look up later.

```
npm run check    # build, lint, format, dead code, specs
```

## Setup

In a game in this repo:

```jsonc
// package.json
"dependencies": { "@dbc/trellis": "file:../trellis" }

// tsconfig.json
"typeRoots": ["node_modules/@rbxts", "node_modules/@dbc"]
```

```jsonc
// default.project.json, inside ReplicatedStorage.rbxts_include.node_modules
"@dbc": {
  "$className": "Folder",
  "trellis": {
    "$className": "Folder",
    "out": { "$path": "node_modules/@dbc/trellis/out" }
  }
}
```

Build trellis once (`npm install && npm run build` in this folder) before building the game.

## A small example

A contract lists what one service and its clients send each other. Both sides import it.

```ts
// shared/contracts.ts
import { command, contract, event, isIntegerIn, isRecord, isStringMax, playerProperty, request } from "@dbc/trellis";

interface Order {
	readonly item: string;
	readonly count: number;
}

export const ShopContract = contract("shop", {
	buy: request<Order, boolean>(isRecord<Order>({ item: isStringMax(32), count: isIntegerIn(1, 99) }), 10),
	coins: playerProperty<number>(),
	sold: event<string>(),
});
```

The server side:

```ts
// server/shop.ts
import { Server } from "@dbc/trellis";

export const service = Server.service({
	name: "shop",
	deps: [Wallet.service],
	contract: ShopContract,
	handlers: {
		buy: (player, order) => {
			const price = Prices.get(order.item);
			if (price === undefined || !Wallet.spend(player, price * order.count)) return false;
			service.client.sold.fireAll(order.item);
			return true;
		},
	},
	init: () => {
		Server.onJoined((player) => service.client.coins.set(player, Wallet.coins(player)));
	},
});

// server/main.server.ts
configure({ name: "MyGame", codePrefix: "MG-", errorLine: (code) => `Something broke (${code}).` });
Server.boot([Wallet.service, Shop.service]);
```

The client side:

```ts
// client/shop.ts
import { Client } from "@dbc/trellis";

const shop = Client.use(ShopContract);

export const controller = Client.controller({
	name: "shop",
	init: () => {
		shop.coins.observe((coins) => render(coins));
		buyButton.Activated.Connect(() => {
			if (shop.buy({ item: "apple", count: 1 }) === true) Sounds.play("buy");
		});
	},
});

// client/main.client.ts
configure({ name: "MyGame", codePrefix: "MG-", errorLine: (code) => `Something broke (${code}).` });
Client.boot([Shop.controller]);
```

## Contracts

| Kind | Direction | Server | Client |
| --- | --- | --- | --- |
| `command<P>(check, budget)` | client to server | handler `(player, payload) => void` | `shop.poke(payload)` returns at once |
| `request<P, A>(check, budget)` | client to server, with an answer | handler `(player, payload) => A` | `shop.buy(payload)` waits, returns `A` or `undefined` |
| `event<P>()` | server to clients | `client.sold.fire(player, x)`, `fireAll(x)` | `shop.sold.connect(fn)` |
| `playerProperty<V>()` | server to one client | `client.coins.set(player, v)`, `get(player)` | `shop.coins.get()`, `observe(fn)` |
| `sharedProperty<V>()` | server to every client | `client.open.set(v)`, `get()` | `shop.open.get()`, `observe(fn)` |

Commands and requests can't be declared without a check and a budget. A check is a function from
`unknown` to a type guard; the ones included are `isString`, `isBoolean`, `isNothing`,
`isNumber` (no NaN or infinity), `isIntegerIn`, `isStringMax`, `isOneOf`, `isRecord` (exact
keys, extra keys fail) and `isArrayOf` (no holes). A budget is how many calls one player can
make in 10 seconds.

The remotes live in `ReplicatedStorage.trellis.<contract>.<member>`. Renaming a contract or a
member changes the wire.

## What happens to a client call

1. If the service isn't running (still booting, or it failed), the call is dropped.
2. If the payload fails the member's check, the call is dropped.
3. The call is counted (`Server.onAccepted`).
4. If the player is over the member's budget, the call is dropped (`Server.onDenied`).
5. The handler runs. If it throws, the error is recorded and the player gets a code. A request
   that threw answers `undefined`.

Handlers should still treat everything in the payload as a claim. Check prices, ids and
distances against server data.

## Properties and events

A property is state. `set` stores the value and sends it, at most once per frame however many
times it was set. A client gets nothing until it says hello, which happens at the end of
`Client.boot`, once every controller is listening. The server answers the hello with every
property value the player should have.

An event is a moment. It only goes to clients that have said hello, and is dropped for the rest.
If a client that joins late needs to see something, make it a property.

## Players

On the server, services don't connect to `Players` themselves:

- `Server.onJoined(fn)` runs for every player once boot is done, starting with the players who
  were already in.
- `Server.onLeft(fn)` handlers run in reverse order, so a service that subscribed first (like
  analytics) hears a leave last.
- Both can only be called from a service's `init` or `start`, and a handler only runs while its
  service is running.

On the client, `Client.onJoined(fn)` runs for every player in the server and each new one.

## Boot

`Server.boot(list)` sorts the services so dependencies come first and otherwise keeps the order
you gave. It creates every remote, then runs each service's `init` and then its `start`, one
service at a time. A service that throws is recorded, and every service that depends on it is
skipped. A cycle, a dependency missing from the list or a name used twice stops the boot.

The server always prints two lines:

```
[MyGame][Server] initialized: 24 services ok in 4ms, slowest world=2,field=1,boosts=0
[MyGame][Server] boot split (ms): catalog=0 analytics=0 profile=0 ...
```

Both boots return a `BootReport` with `ok`, `totalMs`, `split`, `failed` and `skipped`.
`Client.boot` only prints in Studio.

## Errors

Every error a player hits gets one code, like `MG-7KQ2XD` (no 0, O, 1 or I, so it reads back
easily). The player sees one line made by your `errorLine` setting from the code and the site.
The server logs the full record under the same code, so a player's screenshot leads you to the
message and stack.

- A handler that throws: recorded on the server, and the code goes to the player.
- A service that fails to boot: recorded at the site `boot`.
- A client error: the client makes the code, shows the line, and sends the record up. Each site
  reports once per session, and a client sends at most 5.
- Uncaught errors on either side are caught too.

Sites are `boot`, `net` and `uncaught`, plus any you list in `sites`. Code that runs for a
player outside a handler can use the same handling:

```ts
Server.guard("purchase:vip", player, () => grantVip(player));
const code = Server.record({ side: "server", site: "save", message, stack });
Server.onError((entry) => Analytics.record(entry)); // records made before this are kept for it
Client.onErrorLine((code, site) => Toasts.show(errorLine(code, site)));
```

## Settings

```ts
configure({
	name: "MyGame",          // log lines start with [MyGame]
	codePrefix: "MG-",       // capital letters and a dash; don't change it after launch
	errorLine: (code, site) => `${site} failed (${code}). Send a screenshot to support.`,
	sites: ["purchase"],     // extra error sites
	recordContext: () => `phase=${Round.phase()}`, // added to the server's error log line
});
```

Call `configure` on both sides before `boot`. It can't be called after.

## What it doesn't do

- The server never calls a client and waits for an answer. A client can hold that call forever.
- No middleware. The steps above are fixed.
- No promises. A request waits in the thread that called it.

## Development

`npm run check` runs everything CI runs. The specs live in `src/tests`. They are compiled into a
place with Rojo and run under Lune (`scripts/run-specs.luau`), where a server and a client boot
in the same process and talk through fake remotes. Tools are pinned in `rokit.toml`.
