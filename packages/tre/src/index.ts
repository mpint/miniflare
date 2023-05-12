import assert from "assert";
import crypto from "crypto";
import fs from "fs";
import http from "http";
import net from "net";
import os from "os";
import path from "path";
import { Duplex } from "stream";
import { ReadableStream } from "stream/web";
import type { RequestInitCfProperties } from "@cloudflare/workers-types/experimental";
import exitHook from "exit-hook";
import stoppable from "stoppable";
import { WebSocketServer } from "ws";
import { z } from "zod";
import { fallbackCf, setupCf } from "./cf";
import {
  Headers,
  Request,
  RequestInit,
  Response,
  coupleWebSocket,
  fetch,
} from "./http";
import {
  DispatchFetch,
  DurableObjectClassNames,
  GatewayConstructor,
  GatewayFactory,
  HEADER_CF_BLOB,
  PLUGIN_ENTRIES,
  Persistence,
  PluginServicesOptions,
  Plugins,
  QueueConsumers,
  QueuesError,
  SERVICE_ENTRY,
  SOCKET_ENTRY,
  SharedOptions,
  WorkerOptions,
  getGlobalServices,
  maybeGetSitesManifestModule,
  normaliseDurableObject,
} from "./plugins";
import {
  JsonErrorSchema,
  SourceOptions,
  getUserServiceName,
  handlePrettyErrorRequest,
  reviveError,
} from "./plugins/core";
import {
  Config,
  Runtime,
  RuntimeOptions,
  Service,
  Socket,
  Worker_Binding,
  Worker_Module,
  serializeConfig,
} from "./runtime";
import {
  HttpError,
  Log,
  MiniflareCoreError,
  Mutex,
  NoOpLog,
  OptionalZodTypeOf,
  Timers,
  defaultTimers,
  formatResponse,
} from "./shared";
import { NewStorage } from "./storage2";
import { CoreHeaders } from "./workers";

// ===== `Miniflare` User Options =====
export type MiniflareOptions = SharedOptions &
  (WorkerOptions | { workers: WorkerOptions[] });

// ===== `Miniflare` Validated Options =====
type PluginWorkerOptions = {
  [Key in keyof Plugins]: z.infer<Plugins[Key]["options"]>;
};
type PluginSharedOptions = {
  [Key in keyof Plugins]: OptionalZodTypeOf<Plugins[Key]["sharedOptions"]>;
};

function validateOptions(
  opts: MiniflareOptions
): [PluginSharedOptions, PluginWorkerOptions[]] {
  // Normalise options into shared and worker-specific
  const sharedOpts = opts;
  const multipleWorkers = "workers" in opts;
  const workerOpts = multipleWorkers ? opts.workers : [opts];
  if (workerOpts.length === 0) {
    throw new MiniflareCoreError("ERR_NO_WORKERS", "No workers defined");
  }

  // Initialise return values
  const pluginSharedOpts = {} as PluginSharedOptions;
  const pluginWorkerOpts = Array.from(Array(workerOpts.length)).map(
    () => ({} as PluginWorkerOptions)
  );

  // Validate all options
  for (const [key, plugin] of PLUGIN_ENTRIES) {
    // @ts-expect-error `QueuesPlugin` doesn't define shared options
    pluginSharedOpts[key] = plugin.sharedOptions?.parse(sharedOpts);
    for (let i = 0; i < workerOpts.length; i++) {
      // Make sure paths are correct in validation errors
      const path = multipleWorkers ? ["workers", i] : undefined;
      // @ts-expect-error `CoreOptionsSchema` has required options which are
      //  missing in other plugins' options.
      pluginWorkerOpts[i][key] = plugin.options.parse(workerOpts[i], { path });
    }
  }

  // Validate names unique
  const names = new Set<string>();
  for (const opts of pluginWorkerOpts) {
    const name = opts.core.name ?? "";
    if (names.has(name)) {
      throw new MiniflareCoreError(
        "ERR_DUPLICATE_NAME",
        name === ""
          ? "Multiple workers defined without a `name`"
          : `Multiple workers defined with the same \`name\`: "${name}"`
      );
    }
    names.add(name);
  }

  return [pluginSharedOpts, pluginWorkerOpts];
}

// When creating user worker services, we need to know which Durable Objects
// they export. Rather than parsing JavaScript to search for class exports
// (which would have to be recursive because of `export * from ...`), we collect
// all Durable Object bindings, noting that bindings may be defined for objects
// in other services.
function getDurableObjectClassNames(
  allWorkerOpts: PluginWorkerOptions[]
): DurableObjectClassNames {
  const serviceClassNames: DurableObjectClassNames = new Map();
  for (const workerOpts of allWorkerOpts) {
    const workerServiceName = getUserServiceName(workerOpts.core.name);
    for (const designator of Object.values(
      workerOpts.do.durableObjects ?? {}
    )) {
      // Fallback to current worker service if name not defined
      const [className, serviceName = workerServiceName] =
        normaliseDurableObject(designator);
      let classNames = serviceClassNames.get(serviceName);
      if (classNames === undefined) {
        classNames = new Set();
        serviceClassNames.set(serviceName, classNames);
      }
      classNames.add(className);
    }
  }
  return serviceClassNames;
}

function getQueueConsumers(
  allWorkerOpts: PluginWorkerOptions[]
): QueueConsumers {
  const queueConsumers: QueueConsumers = new Map();
  for (const workerOpts of allWorkerOpts) {
    const workerName = workerOpts.core.name ?? "";
    let workerConsumers = workerOpts.queues.queueConsumers;
    if (workerConsumers !== undefined) {
      // De-sugar array consumer options to record mapping to empty options
      if (Array.isArray(workerConsumers)) {
        workerConsumers = Object.fromEntries(
          workerConsumers.map((queueName) => [queueName, {}])
        );
      }

      for (const [queueName, opts] of Object.entries(workerConsumers)) {
        // Validate that each queue has at most one consumer...
        const existingConsumer = queueConsumers.get(queueName);
        if (existingConsumer !== undefined) {
          throw new QueuesError(
            "ERR_MULTIPLE_CONSUMERS",
            `Multiple consumers defined for queue "${queueName}": "${existingConsumer.workerName}" and "${workerName}"`
          );
        }
        // ...then store the consumer
        queueConsumers.set(queueName, { workerName, ...opts });
      }
    }
  }

  // Populate all `deadLetterConsumer`s, note this may create cycles
  for (const [queueName, consumer] of queueConsumers) {
    if (consumer.deadLetterQueue !== undefined) {
      // Check the dead letter queue isn't configured to be the queue itself
      // (NOTE: Queues *does* permit DLQ cycles between multiple queues,
      //  i.e. if Q2 is DLQ for Q1, but Q1 is DLQ for Q2)
      if (consumer.deadLetterQueue === queueName) {
        throw new QueuesError(
          "ERR_DEAD_LETTER_QUEUE_CYCLE",
          `Dead letter queue for queue "${queueName}" cannot be itself`
        );
      }
      consumer.deadLetterConsumer = queueConsumers.get(
        consumer.deadLetterQueue
      );
    }
  }

  return queueConsumers;
}

// Collects all routes from all worker services
function getWorkerRoutes(
  allWorkerOpts: PluginWorkerOptions[]
): Map<string, string[]> {
  const allRoutes = new Map<string, string[]>();
  for (const workerOpts of allWorkerOpts) {
    const name = workerOpts.core.name ?? "";
    assert(!allRoutes.has(name)); // Validated unique names earlier
    allRoutes.set(name, workerOpts.core.routes ?? []);
  }
  return allRoutes;
}

// ===== `Miniflare` Internal Storage & Routing =====
type OptionalGatewayFactoryType<
  Gateway extends GatewayConstructor<any> | undefined
> = Gateway extends GatewayConstructor<any>
  ? GatewayFactory<InstanceType<Gateway>>
  : undefined;
type OptionalInstanceType<
  T extends (abstract new (...args: any) => any) | undefined
> = T extends abstract new (...args: any) => any ? InstanceType<T> : undefined;
type PluginGatewayFactories = {
  [Key in keyof Plugins]: OptionalGatewayFactoryType<Plugins[Key]["gateway"]>;
};
type PluginRouters = {
  [Key in keyof Plugins]: OptionalInstanceType<Plugins[Key]["router"]>;
};

type StoppableServer = http.Server & stoppable.WithStop;

const restrictedUndiciHeaders = [
  // From Miniflare 2:
  // https://github.com/cloudflare/miniflare/blob/9c135599dc21fe69080ada17fce6153692793bf1/packages/core/src/standards/http.ts#L129-L132
  "transfer-encoding",
  "connection",
  "keep-alive",
  "expect",
];
const restrictedWebSocketUpgradeHeaders = [
  "upgrade",
  "connection",
  "sec-websocket-accept",
];

async function writeResponse(response: Response, res: http.ServerResponse) {
  const headers = Object.fromEntries(response.headers);
  res.writeHead(response.status, response.statusText, headers);
  if (response.body) {
    for await (const chunk of response.body) {
      if (chunk) res.write(chunk);
    }
  }
  res.end();
}

function safeReadableStreamFrom(iterable: AsyncIterable<Uint8Array>) {
  // Adapted from `undici`, catches errors from `next()` to avoid unhandled
  // rejections from aborted request body streams:
  // https://github.com/nodejs/undici/blob/dfaec78f7a29f07bb043f9006ed0ceb0d5220b55/lib/core/util.js#L369-L392
  let iterator: AsyncIterator<Uint8Array>;
  return new ReadableStream<Uint8Array>(
    {
      async start() {
        iterator = iterable[Symbol.asyncIterator]();
      },
      // @ts-expect-error `pull` may return anything
      async pull(controller): Promise<boolean> {
        try {
          const { done, value } = await iterator.next();
          if (done) {
            queueMicrotask(() => controller.close());
          } else {
            const buf = Buffer.isBuffer(value) ? value : Buffer.from(value);
            controller.enqueue(new Uint8Array(buf));
          }
        } catch {
          queueMicrotask(() => controller.close());
        }
        // @ts-expect-error `pull` may return anything
        return controller.desiredSize > 0;
      },
      async cancel() {
        await iterator.return?.();
      },
    },
    0
  );
}

export class Miniflare {
  readonly #gatewayFactories: PluginGatewayFactories;
  readonly #routers: PluginRouters;
  #sharedOpts: PluginSharedOptions;
  #workerOpts: PluginWorkerOptions[];
  #log: Log;
  readonly #timers: Timers;
  readonly #host: string;
  readonly #accessibleHost: string;

  #runtime?: Runtime;
  #removeRuntimeExitHook?: () => void;
  #runtimeEntryURL?: URL;

  // Path to temporary directory for use as scratch space/"in-memory" Durable
  // Object storage. Note this may not exist, it's up to the consumers to
  // create this if needed. Deleted on `dispose()`.
  readonly #tmpPath: string;
  readonly #removeTmpPathExitHook: () => void;

  // Mutual exclusion lock for runtime operations (i.e. initialisation and
  // updating config). This essentially puts initialisation and future updates
  // in a queue, ensuring they're performed in calling order.
  readonly #runtimeMutex: Mutex;

  // Store `#init()` `Promise`, so we can propagate initialisation errors in
  // `ready`. We would have no way of catching these otherwise.
  readonly #initPromise: Promise<void>;

  // Aborted when dispose() is called
  readonly #disposeController: AbortController;
  #loopbackServer?: StoppableServer;
  #loopbackPort?: number;
  readonly #liveReloadServer: WebSocketServer;
  readonly #webSocketServer: WebSocketServer;
  readonly #webSocketExtraHeaders: WeakMap<http.IncomingMessage, Headers>;

  constructor(opts: MiniflareOptions) {
    // Initialise plugin gateway factories and routers
    this.#gatewayFactories = {} as PluginGatewayFactories;
    this.#routers = {} as PluginRouters;

    // Split and validate options
    const [sharedOpts, workerOpts] = validateOptions(opts);
    this.#sharedOpts = sharedOpts;
    this.#workerOpts = workerOpts;
    this.#log = this.#sharedOpts.core.log ?? new NoOpLog();
    this.#timers = this.#sharedOpts.core.timers ?? defaultTimers;
    this.#host = this.#sharedOpts.core.host ?? "127.0.0.1";
    this.#accessibleHost =
      this.#host === "*" || this.#host === "0.0.0.0" ? "127.0.0.1" : this.#host;
    this.#initPlugins();

    this.#liveReloadServer = new WebSocketServer({ noServer: true });
    this.#webSocketServer = new WebSocketServer({
      noServer: true,
      // Disable automatic handling of `Sec-WebSocket-Protocol` header,
      // Cloudflare Workers require users to include this header themselves in
      // `Response`s: https://github.com/cloudflare/miniflare/issues/179
      handleProtocols: () => false,
    });
    // Add custom headers included in response to WebSocket upgrade requests
    this.#webSocketExtraHeaders = new WeakMap();
    this.#webSocketServer.on("headers", (headers, req) => {
      const extra = this.#webSocketExtraHeaders.get(req);
      this.#webSocketExtraHeaders.delete(req);
      if (extra) {
        for (const [key, value] of extra) {
          if (!restrictedWebSocketUpgradeHeaders.includes(key.toLowerCase())) {
            headers.push(`${key}: ${value}`);
          }
        }
      }
    });

    // Build path for temporary directory. We don't actually want to create this
    // unless it's needed (i.e. we have Durable Objects enabled). This means we
    // can't use `fs.mkdtemp()`, as that always creates the directory.
    this.#tmpPath = path.join(
      os.tmpdir(),
      `miniflare-${crypto.randomBytes(16).toString("hex")}`
    );
    this.#removeTmpPathExitHook = exitHook(() => {
      fs.rmSync(this.#tmpPath, { force: true, recursive: true });
    });

    this.#disposeController = new AbortController();
    this.#runtimeMutex = new Mutex();
    this.#initPromise = this.#runtimeMutex.runWith(() => this.#init());
  }

  #initPlugins() {
    for (const [key, plugin] of PLUGIN_ENTRIES) {
      if (plugin.gateway !== undefined && plugin.router !== undefined) {
        const gatewayFactory = new GatewayFactory<any>(
          this.#log,
          this.#timers,
          this.dispatchFetch,
          this.#sharedOpts.core.cloudflareFetch,
          key,
          plugin.gateway,
          plugin.remoteStorage
        );
        const router = new plugin.router(this.#log, gatewayFactory);
        // @ts-expect-error this.#gatewayFactories[key] could be any plugin's
        this.#gatewayFactories[key] = gatewayFactory;
        // @ts-expect-error this.#routers[key] could be any plugin's
        this.#routers[key] = router;
      }
    }
  }

  #handleReload() {
    // Reload all connected live reload clients
    for (const ws of this.#liveReloadServer.clients) {
      ws.close(1012, "Service Restart");
    }
    // Close all existing web sockets on reload
    for (const ws of this.#webSocketServer.clients) {
      ws.close(1012, "Service Restart");
    }
  }

  async #init() {
    // This function must be run with `#runtimeMutex` held

    // Start loopback server (how the runtime accesses with Miniflare's storage)
    // using the same host as the main runtime server. This means we can use the
    // loopback server for live reload updates too.
    this.#loopbackServer = await this.#startLoopbackServer(0, this.#host);
    const address = this.#loopbackServer.address();
    // Note address would be string with unix socket
    assert(address !== null && typeof address === "object");
    // noinspection JSObjectNullOrUndefined
    this.#loopbackPort = address.port;

    // Start runtime
    const port = this.#sharedOpts.core.port ?? 0;
    const opts: RuntimeOptions = {
      entryHost: this.#host,
      entryPort: port,
      loopbackPort: this.#loopbackPort,
      inspectorPort: this.#sharedOpts.core.inspectorPort,
      verbose: this.#sharedOpts.core.verbose,
    };
    this.#runtime = new Runtime(opts);
    this.#removeRuntimeExitHook = exitHook(() => void this.#runtime?.dispose());

    // Update config and wait for runtime to start
    await this.#assembleAndUpdateConfig(/* initial */ true);
  }

  async #handleLoopbackCustomService(
    request: Request,
    customService: string
  ): Promise<Response> {
    const slashIndex = customService.indexOf("/");
    // TODO: technically may want to keep old versions around so can always
    //  recover this in case of setOptions()?
    const workerIndex = parseInt(customService.substring(0, slashIndex));
    const serviceName = customService.substring(slashIndex + 1);
    const service =
      this.#workerOpts[workerIndex]?.core.serviceBindings?.[serviceName];
    // Should only define custom service bindings if `service` is a function
    assert(typeof service === "function");
    try {
      const response = await service(request);
      // Validate return type as `service` is a user defined function
      // TODO: should we validate outside this try/catch?
      return z.instanceof(Response).parse(response);
    } catch (e: any) {
      // TODO: do we need to add `CF-Exception` header or something here?
      //  check what runtime does
      return new Response(e?.stack ?? e, { status: 500 });
    }
  }

  async #handleLoopbackPlugins(
    request: Request<RequestInitCfProperties>,
    url: URL
  ): Promise<Response | undefined> {
    const pathname = url.pathname;
    for (const [key] of PLUGIN_ENTRIES) {
      const pluginPrefix = `/${key}`;
      if (pathname.startsWith(pluginPrefix)) {
        // Reuse existing URL object, just remove prefix from pathname
        url.pathname = pathname.substring(pluginPrefix.length);
        // Try route using this plugin, and respond if matched
        try {
          const response = await this.#routers[key]?.route(request, url);
          if (response !== undefined) return response;
        } catch (e) {
          if (e instanceof HttpError) return e.toResponse();
          throw e;
        }
      }
    }
  }

  get #workerSrcOpts(): SourceOptions[] {
    return this.#workerOpts.map<SourceOptions>(({ core }) => core);
  }

  #handleLoopback = async (
    req: http.IncomingMessage,
    res?: http.ServerResponse
  ): Promise<Response | undefined> => {
    // Extract headers from request
    const headers = new Headers();
    for (const [name, values] of Object.entries(req.headers)) {
      // These headers are unsupported in undici fetch requests, they're added
      // automatically. For custom service bindings, we may pass this request
      // straight through to another fetch so strip them now.
      if (restrictedUndiciHeaders.includes(name)) continue;
      if (Array.isArray(values)) {
        for (const value of values) headers.append(name, value);
      } else if (values !== undefined) {
        headers.append(name, values);
      }
    }

    // Extract cf blob (if any) from headers
    const cfBlob = headers.get(HEADER_CF_BLOB);
    headers.delete(HEADER_CF_BLOB);
    assert(!Array.isArray(cfBlob)); // Only `Set-Cookie` headers are arrays
    const cf = cfBlob ? JSON.parse(cfBlob) : undefined;

    // Extract original URL passed to `fetch`
    const url = new URL(
      headers.get(CoreHeaders.ORIGINAL_URL) ?? req.url ?? "",
      "http://127.0.0.1"
    );
    headers.delete(CoreHeaders.ORIGINAL_URL);

    const noBody = req.method === "GET" || req.method === "HEAD";
    const body = noBody ? undefined : safeReadableStreamFrom(req);
    const request = new Request(url, {
      method: req.method,
      headers,
      body,
      duplex: "half",
      cf,
    });

    let response: Response | undefined;
    try {
      const customService = request.headers.get(CoreHeaders.CUSTOM_SERVICE);
      if (customService !== null) {
        request.headers.delete(CoreHeaders.CUSTOM_SERVICE);
        response = await this.#handleLoopbackCustomService(
          request,
          customService
        );
      } else if (url.pathname === "/core/error") {
        response = await handlePrettyErrorRequest(
          this.#log,
          this.#workerSrcOpts,
          request
        );
      } else if (url.pathname === "/core/log") {
        this.#log.info(await formatResponse(request));
      } else {
        // TODO: check for proxying/outbound fetch header first (with plans for fetch mocking)
        response = await this.#handleLoopbackPlugins(request, url);
      }
    } catch (e: any) {
      this.#log.error(e);
      res?.writeHead(500);
      res?.end(e?.stack ?? String(e));
      return;
    }

    if (res !== undefined) {
      if (response === undefined) {
        res.writeHead(404);
        res.end();
      } else {
        await writeResponse(response, res);
      }
    }

    return response;
  };

  #handleLoopbackUpgrade = async (
    req: http.IncomingMessage,
    socket: Duplex,
    head: Buffer
  ) => {
    // Only interested in pathname so base URL doesn't matter
    const { pathname } = new URL(req.url ?? "", "http://localhost");

    // If this is the path for live-reload, handle the request
    if (pathname === "/cdn-cgi/mf/reload") {
      this.#liveReloadServer.handleUpgrade(req, socket, head, (ws) => {
        this.#liveReloadServer.emit("connection", ws, req);
      });
      return;
    }

    // Otherwise, try handle the request in a worker
    const response = await this.#handleLoopback(req);

    // Check web socket response was returned
    const webSocket = response?.webSocket;
    if (response?.status === 101 && webSocket) {
      // Accept and couple the Web Socket
      this.#webSocketExtraHeaders.set(req, response.headers);
      this.#webSocketServer.handleUpgrade(req, socket, head, (ws) => {
        void coupleWebSocket(ws, webSocket);
        this.#webSocketServer.emit("connection", ws, req);
      });
      return;
    }

    // Otherwise, we'll be returning a regular HTTP response
    const res = new http.ServerResponse(req);
    // `socket` is guaranteed to be an instance of `net.Socket`:
    // https://nodejs.org/api/http.html#event-upgrade_1
    assert(socket instanceof net.Socket);
    res.assignSocket(socket);

    // If no response was provided, or it was an "ok" response, log an error
    if (!response || response.ok) {
      res.writeHead(500);
      res.end();
      this.#log.error(
        new TypeError(
          "Web Socket request did not return status 101 Switching Protocols response with Web Socket"
        )
      );
      return;
    }

    // Otherwise, send the response as is (e.g. unauthorised)
    await writeResponse(response, res);
  };

  #startLoopbackServer(
    port: string | number,
    hostname?: string
  ): Promise<StoppableServer> {
    return new Promise((resolve) => {
      const server = stoppable(http.createServer(this.#handleLoopback));
      server.on("upgrade", this.#handleLoopbackUpgrade);
      server.listen(port as any, hostname, () => resolve(server));
    });
  }

  #stopLoopbackServer(): Promise<void> {
    return new Promise((resolve, reject) => {
      assert(this.#loopbackServer !== undefined);
      this.#loopbackServer.stop((err) => (err ? reject(err) : resolve()));
    });
  }

  async #assembleConfig(): Promise<Config> {
    const allWorkerOpts = this.#workerOpts;
    const sharedOpts = this.#sharedOpts;
    const loopbackPort = this.#loopbackPort;
    // #assembleConfig is always called after the loopback server is created
    assert(loopbackPort !== undefined);

    sharedOpts.core.cf = await setupCf(this.#log, sharedOpts.core.cf);

    const durableObjectClassNames = getDurableObjectClassNames(allWorkerOpts);
    const queueConsumers = getQueueConsumers(allWorkerOpts);
    const allWorkerRoutes = getWorkerRoutes(allWorkerOpts);

    // Use Map to dedupe services by name
    const services = new Map<string, Service>();
    const globalServices = getGlobalServices({
      sharedOptions: sharedOpts.core,
      allWorkerRoutes,
      fallbackWorkerName: this.#workerOpts[0].core.name,
      loopbackPort,
      log: this.#log,
    });
    for (const service of globalServices) {
      // Global services should all have unique names
      assert(service.name !== undefined && !services.has(service.name));
      services.set(service.name, service);
    }

    const sockets: Socket[] = [
      {
        name: SOCKET_ENTRY,
        service: { name: SERVICE_ENTRY },
        // Even though we inject a `cf` object in the entry worker, allow it to
        // be customised via `dispatchFetch`
        http: { cfBlobHeader: HEADER_CF_BLOB },
      },
    ];

    for (let i = 0; i < allWorkerOpts.length; i++) {
      const workerOpts = allWorkerOpts[i];

      // Collect all bindings from this worker
      const workerBindings: Worker_Binding[] = [];
      const additionalModules: Worker_Module[] = [];
      for (const [key, plugin] of PLUGIN_ENTRIES) {
        // @ts-expect-error `CoreOptionsSchema` has required options which are
        //  missing in other plugins' options.
        const pluginBindings = await plugin.getBindings(workerOpts[key], i);
        if (pluginBindings !== undefined) {
          workerBindings.push(...pluginBindings);

          if (key === "kv") {
            // Add "__STATIC_CONTENT_MANIFEST" module if sites enabled
            const module = maybeGetSitesManifestModule(pluginBindings);
            if (module !== undefined) additionalModules.push(module);
          }
        }
      }

      // Collect all services required by this worker
      const pluginServicesOptionsBase: Omit<
        PluginServicesOptions<z.ZodTypeAny, undefined>,
        "options" | "sharedOptions"
      > = {
        log: this.#log,
        workerBindings,
        workerIndex: i,
        additionalModules,
        tmpPath: this.#tmpPath,
        durableObjectClassNames,
        queueConsumers,
      };
      for (const [key, plugin] of PLUGIN_ENTRIES) {
        const pluginServices = await plugin.getServices({
          ...pluginServicesOptionsBase,
          // @ts-expect-error `CoreOptionsSchema` has required options which are
          //  missing in other plugins' options.
          options: workerOpts[key],
          // @ts-expect-error `QueuesPlugin` doesn't define shared options
          sharedOptions: sharedOpts[key],
        });
        if (pluginServices !== undefined) {
          for (const service of pluginServices) {
            if (service.name !== undefined && !services.has(service.name)) {
              services.set(service.name, service);
            }
          }
        }
      }
    }

    return { services: Array.from(services.values()), sockets };
  }

  async #assembleAndUpdateConfig(initial = false) {
    assert(this.#runtime !== undefined);
    const config = await this.#assembleConfig();
    const configBuffer = serializeConfig(config);
    const maybePort = await this.#runtime.updateConfig(configBuffer, {
      signal: this.#disposeController.signal,
    });
    if (this.#disposeController.signal.aborted) return;
    if (maybePort === undefined) {
      throw new MiniflareCoreError(
        "ERR_RUNTIME_FAILURE",
        "The Workers runtime failed to start. " +
          "There is likely additional logging output above."
      );
    }
    // noinspection HttpUrlsUsage
    this.#runtimeEntryURL = new URL(
      `http://${this.#accessibleHost}:${maybePort}`
    );

    if (!this.#runtimeMutex.hasWaiting) {
      // Only log and trigger reload if there aren't pending updates
      const ready = initial ? "Ready" : "Updated and ready";
      this.#log.info(`${ready} on ${this.#runtimeEntryURL}`);
      this.#handleReload();
    }
  }

  async #waitForReady() {
    // If `#init()` threw, we'd like to propagate the error here, so `await` it.
    // Note we can't use `async`/`await` with getters. We'd also like to wait
    // for `setOptions` calls to complete before resolving.
    await this.#initPromise;
    // We'd also like to wait for `setOptions` calls to complete before, so wait
    // for runtime mutex to drain (i.e. all options updates applied).
    // (NOTE: can't just repeatedly wait on the mutex as use the presence of
    // waiters on the mutex to avoid logging ready/updated messages to the
    // console if there are future updates)
    await this.#runtimeMutex.drained();
    // `#runtimeEntryURL` is assigned in `#assembleAndUpdateConfig()`, which is
    // called by `#init()`, and `#initPromise` doesn't resolve until `#init()`
    // returns.
    assert(this.#runtimeEntryURL !== undefined);
    return this.#runtimeEntryURL;
  }
  get ready(): Promise<URL> {
    return this.#waitForReady();
  }

  #checkDisposed() {
    if (this.#disposeController.signal.aborted) {
      throw new MiniflareCoreError(
        "ERR_DISPOSED",
        "Cannot use disposed instance"
      );
    }
  }

  async #setOptions(opts: MiniflareOptions) {
    // This function must be run with `#runtimeMutex` held

    // Split and validate options
    const [sharedOpts, workerOpts] = validateOptions(opts);
    this.#sharedOpts = sharedOpts;
    this.#workerOpts = workerOpts;
    this.#log = this.#sharedOpts.core.log ?? this.#log;

    // Send to runtime and wait for updates to process
    await this.#assembleAndUpdateConfig();
  }

  setOptions(opts: MiniflareOptions): Promise<void> {
    this.#checkDisposed();
    // Wait for initial initialisation and other setOptions to complete before
    // changing options
    return this.#runtimeMutex.runWith(() => this.#setOptions(opts));
  }

  dispatchFetch: DispatchFetch = async (input, init) => {
    this.#checkDisposed();
    await this.ready;
    const forward = new Request(input, init);
    const url = new URL(forward.url);
    forward.headers.set(CoreHeaders.ORIGINAL_URL, url.toString());
    url.protocol = this.#runtimeEntryURL!.protocol;
    url.host = this.#runtimeEntryURL!.host;
    if (forward.cf) {
      const cf = { ...fallbackCf, ...forward.cf };
      forward.headers.set(HEADER_CF_BLOB, JSON.stringify(cf));
    }
    // Remove `Content-Length: 0` headers from requests when a body is set to
    // avoid `RequestContentLengthMismatch` errors
    if (
      forward.body !== null &&
      forward.headers.get("Content-Length") === "0"
    ) {
      forward.headers.delete("Content-Length");
    }

    const response = await fetch(url, forward as RequestInit);

    // If the Worker threw an uncaught exception, propagate it to the caller
    const stack = response.headers.get(CoreHeaders.ERROR_STACK);
    if (response.status === 500 && stack !== null) {
      const caught = JsonErrorSchema.parse(await response.json());
      throw reviveError(this.#workerSrcOpts, caught);
    }

    return response;
  };

  /** @internal */
  _getPluginStorage(
    plugin: keyof Plugins,
    namespace: string,
    persist?: Persistence
  ): NewStorage {
    const factory = this.#gatewayFactories[plugin];
    assert(factory !== undefined);
    return factory.getStorage(namespace, persist).getNewStorage();
  }

  async dispose(): Promise<void> {
    this.#disposeController.abort();
    try {
      await this.ready;
    } finally {
      // Remove exit hooks, we're cleaning up what they would've cleaned up now
      this.#removeTmpPathExitHook();
      this.#removeRuntimeExitHook?.();

      // Cleanup as much as possible even if `#init()` threw
      await this.#runtime?.dispose();
      await this.#stopLoopbackServer();
      // `rm -rf ${#tmpPath}`, this won't throw if `#tmpPath` doesn't exist
      await fs.promises.rm(this.#tmpPath, { force: true, recursive: true });
    }
  }
}

export * from "./http";
export * from "./plugins";
export * from "./runtime";
export * from "./shared";
export * from "./storage";
export * from "./storage2";
export * from "./workers";