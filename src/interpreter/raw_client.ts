import http from "node:http";
import type { Program } from "./commands";

const agent = new http.Agent({
  keepAlive: true,
});

export function getCounts(opts: {
  adminUrl: string;
  layer: number;
}): Promise<Map<string, number>> {
  const { adminUrl, layer } = opts;

  const query = `select service_key, value_utf8 from state where key = 'counter' and service_name = 'ObjectInterpreterL${layer}'`;

  return fetch(`${adminUrl}/query`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      query,
    }),
  })
    .then((res) => res.json())
    .then((data) => {
      const counts = new Map<string, number>();
      for (const row of data.rows) {
        counts.set(row.service_key, JSON.parse(row.value_utf8));
      }
      return counts;
    });
}

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
