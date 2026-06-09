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

  // The admin /query endpoint does not always return the expected
  // { rows: [...] } shape: during transient blips (leadership change, node
  // restart, a not-yet-ready query node) it may answer with a non-OK status or
  // an error body. Read the body as text first so we can log what we actually
  // got, then validate it. Any problem throws a descriptive error which the
  // retry() wrapper around getCounts will retry a few times.
  const bodyText = await res.text();

  const fail = (reason: string): never => {
    const snippet = bodyText.slice(0, 2000);
    console.warn(
      `getCounts: ${reason} (status ${res.status} ${res.statusText}); body: ${snippet}`,
    );
    throw new Error(`getCounts: ${reason} (status ${res.status})`);
  };

  if (!res.ok) {
    fail("non-OK response from /query");
  }

  let data: unknown;
  try {
    data = JSON.parse(bodyText);
  } catch (e) {
    fail(`/query response was not valid JSON: ${e}`);
  }

  const rows = (data as { rows?: unknown }).rows;
  if (!Array.isArray(rows)) {
    fail("/query response did not contain a 'rows' array");
  }

  const counts0 = Array.from({ length: numInterpreters }, () => 0);
  const counts1 = Array.from({ length: numInterpreters }, () => 0);
  const counts2 = Array.from({ length: numInterpreters }, () => 0);

  for (const row of rows as Array<Record<string, string>>) {
    if (row.service_key === undefined || row.value_utf8 === undefined) {
      fail(`/query row is missing expected fields: ${JSON.stringify(row)}`);
    }
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
