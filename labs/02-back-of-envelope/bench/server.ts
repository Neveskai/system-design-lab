// Tiny targets for the network benchmark: TCP echo, HTTP and HTTPS.
// They do no work, so whatever the client measures is network + protocol cost.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";

// Self-signed cert generated at start (ECDSA P-256, like most CDNs and ALBs serve).
if (!fs.existsSync("/tmp/key.pem")) {
  execFileSync("openssl", [
    "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes",
    "-keyout", "/tmp/key.pem", "-out", "/tmp/cert.pem", "-days", "2", "-subj", "/CN=server",
  ]);
}

net.createServer((s) => s.pipe(s)).listen(7000);

const body = Buffer.from(JSON.stringify({ ok: true }));
const handler = (_req: http.IncomingMessage, res: http.ServerResponse) => {
  res.writeHead(200, { "content-type": "application/json", "content-length": body.length });
  res.end(body);
};
http.createServer({ keepAliveTimeout: 60_000 }, handler).listen(7001);
https.createServer({ key: fs.readFileSync("/tmp/key.pem"), cert: fs.readFileSync("/tmp/cert.pem"), keepAliveTimeout: 60_000 }, handler).listen(7002);

console.log("server: tcp echo :7000, http :7001, https :7002");
