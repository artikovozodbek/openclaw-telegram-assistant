#!/usr/bin/env node
"use strict";

const http = require("http");
const net = require("net");

const listenHost = process.env.OPENCLAW_CDP_PROXY_HOST || "127.0.0.1";
const listenPort = Number(process.env.OPENCLAW_CDP_PROXY_PORT || "19222");
const upstreamHost = process.env.OPENCLAW_CDP_UPSTREAM_HOST || "host.docker.internal";
const upstreamPort = Number(process.env.OPENCLAW_CDP_UPSTREAM_PORT || "9222");
const publicHost = process.env.OPENCLAW_CDP_PROXY_PUBLIC_HOST || "127.0.0.1";
const publicPort = Number(process.env.OPENCLAW_CDP_PROXY_PUBLIC_PORT || listenPort);

function rewriteBody(body) {
  const publicBase = `${publicHost}:${publicPort}`;
  return body
    .replaceAll(`localhost:${upstreamPort}`, publicBase)
    .replaceAll(`127.0.0.1:${upstreamPort}`, publicBase)
    .replaceAll(`${upstreamHost}:${upstreamPort}`, publicBase)
    .replaceAll(`localhost/devtools/`, `${publicBase}/devtools/`);
}

function proxyHttp(req, res) {
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    const upstreamReq = http.request(
      {
        host: upstreamHost,
        port: upstreamPort,
        method: req.method,
        path: req.url,
        headers: {
          ...req.headers,
          host: `localhost:${upstreamPort}`,
        },
      },
      (upstreamRes) => {
        const responseChunks = [];
        upstreamRes.on("data", (chunk) => responseChunks.push(chunk));
        upstreamRes.on("end", () => {
          const raw = Buffer.concat(responseChunks);
          const contentType = String(upstreamRes.headers["content-type"] || "");
          let out = raw;
          const headers = { ...upstreamRes.headers };
          if (contentType.includes("json") || req.url.startsWith("/json")) {
            out = Buffer.from(rewriteBody(raw.toString("utf8")), "utf8");
            delete headers["content-length"];
          }
          res.writeHead(upstreamRes.statusCode || 502, headers);
          res.end(out);
        });
      },
    );
    upstreamReq.on("error", (err) => {
      res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
      res.end(`CDP proxy upstream error: ${err.message}`);
    });
    for (const chunk of chunks) upstreamReq.write(chunk);
    upstreamReq.end();
  });
}

function proxyUpgrade(req, socket, head) {
  const upstream = net.connect(upstreamPort, upstreamHost, () => {
    const requestLine = `${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`;
    const headers = { ...req.headers, host: `localhost:${upstreamPort}` };
    const headerLines = Object.entries(headers)
      .map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(", ") : value}`)
      .join("\r\n");
    upstream.write(`${requestLine}${headerLines}\r\n\r\n`);
    if (head && head.length) upstream.write(head);
    socket.pipe(upstream);
    upstream.pipe(socket);
  });
  upstream.on("error", () => socket.destroy());
  socket.on("error", () => upstream.destroy());
}

const server = http.createServer(proxyHttp);
server.on("upgrade", proxyUpgrade);
server.listen(listenPort, listenHost, () => {
  console.log(
    `[cdp-proxy] listening on http://${listenHost}:${listenPort}, upstream http://${upstreamHost}:${upstreamPort}`,
  );
});
