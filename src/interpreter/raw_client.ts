import http from "node:http";
import type { Program } from "./commands";

const agent = new http.Agent({
  keepAlive: true,
});

export function sendInterpreter(opts: {
  ingressUrl: URL;
  idempotencyKey: string;
  interpreterId: string;
  program: Program;
}): Promise<void> {
  const { ingressUrl, idempotencyKey, interpreterId, program } = opts;

  const options = {
    method: "POST",
    hostname: ingressUrl.hostname,
    port: ingressUrl.port,
    path: `/ObjectInterpreterL0/${interpreterId}/interpret/send`,
    agent,
    headers: {
      "idempotency-key": idempotencyKey,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
  };

  const { promise, resolve, reject } = Promise.withResolvers<void>();

  const req = http.request(options, function (res) {
    if (res.statusCode === 200 || res.statusCode === 202) {
      resolve();
    } else {
      reject(new Error(`Failed to send: ${res.statusCode}`));
    }

    res.on("data", function (chunk) {});
    res.on("error", function (e) {
      reject(e);
    });
    res.on("end", function () {});
  });

  const jsBody = JSON.stringify(program);

  req.end(jsBody).on("error", function (e) {
    reject(e);
  });

  return promise;
}
