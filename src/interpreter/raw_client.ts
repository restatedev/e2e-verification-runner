import type { Program } from "./commands";

export async function getCounts(opts: {
  adminUrl: string;
  numInterpreters: number;
}): Promise<{ counters: number[][] }> {
  const { adminUrl, numInterpreters } = opts;

  const query = `select service_key, service_name, value_utf8 from state where key = 'counter'`;

  const res = await fetch(`${adminUrl}/query`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      query,
    }),
  });
  const data = await res.json();

  const counts0 = Array.from({ length: numInterpreters }, () => 0);
  const counts1 = Array.from({ length: numInterpreters }, () => 0);
  const counts2 = Array.from({ length: numInterpreters }, () => 0);

  for (const row of data.rows) {
    const key = parseInt(row.service_key);
    const value = JSON.parse(row.value_utf8);
    switch (row.service_name) {
      case "ObjectInterpreterL0":
        counts0[key] = value;
        break;
      case "ObjectInterpreterL1":
        counts1[key] = value;
        break;
      case "ObjectInterpreterL2":
        counts2[key] = value;
        break;
    }
  }
  return { counters: [counts0, counts1, counts2] };
}

export async function sendInterpreter(opts: {
  ingressUrl: URL;
  idempotencyKey: string;
  interpreterId: string;
  program: Program;
}): Promise<void> {
  const { ingressUrl, idempotencyKey, interpreterId, program } = opts;

  let url = new URL(
    `/ObjectInterpreterL0/${interpreterId}/interpret/send`,
    ingressUrl,
  );

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "idempotency-key": idempotencyKey,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    keepalive: true,
    body: JSON.stringify(program),
  });

  if (response.ok) {
    return;
  }
  const errorText = await response.text(); // Capture error response body
  throw new Error(`Failed to send: ${response.status} - ${errorText}`);
}
